"""JSON API used by the single-page app. Every write bumps the user's revision so
other open tabs/devices refresh themselves automatically."""
import json
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from functools import wraps

from django.contrib.auth.decorators import login_required
from django.db import IntegrityError, transaction
from django.db.models import Count, Max, Q, Sum
from django.http import HttpResponse, JsonResponse
from django.views.decorators.http import require_http_methods

from . import dataio, services
from .models import (
    Budget,
    Category,
    Goal,
    Income,
    IncomeSource,
    PaymentMethod,
    Recurring,
    Transaction,
)


class ApiError(Exception):
    def __init__(self, message, field=None, status=400):
        super().__init__(message)
        self.message, self.field, self.status = message, field, status


def api(view):
    @login_required
    @wraps(view)
    def wrapper(request, *args, **kwargs):
        try:
            if request.content_type == "application/json" and request.body:
                request.data = json.loads(request.body)
            else:
                request.data = request.POST.dict()
            result = view(request, *args, **kwargs)
        except ApiError as e:
            return JsonResponse({"error": e.message, "field": e.field}, status=e.status)
        except json.JSONDecodeError:
            return JsonResponse({"error": "Invalid JSON"}, status=400)
        if isinstance(result, HttpResponse):  # e.g. 405 from require_http_methods
            return result
        if request.method != "GET":
            services.bump_revision(request.user)
        payload = result if isinstance(result, dict) else {"results": result}
        payload.setdefault("revision", services.get_profile(request.user).revision)
        return JsonResponse(payload)

    return wrapper


# --------------------------------------------------------------------------- parsing

def p_date(v, field, required=True):
    if v in (None, ""):
        if required:
            raise ApiError("Date is required", field)
        return None
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        raise ApiError("Use a valid date", field)


def p_time(v, field):
    if v in (None, ""):
        return None
    for f in ("%H:%M", "%H:%M:%S", "%I:%M %p", "%I:%M%p"):
        try:
            return datetime.strptime(str(v).strip().upper(), f).time()
        except ValueError:
            continue
    raise ApiError("Use a valid time, e.g. 13:15", field)


def p_amount(v, field="amount", allow_zero=False):
    try:
        d = Decimal(str(v).replace(",", "").strip())
    except (InvalidOperation, AttributeError):
        raise ApiError("Enter an amount", field)
    if d < 0 or (d == 0 and not allow_zero):
        raise ApiError("Amount must be more than 0", field)
    if d >= Decimal("1e12"):
        raise ApiError("Amount is too large", field)
    return d.quantize(Decimal("0.01"))


def p_fk(model, user, v, field, required=False):
    if v in (None, "", "null"):
        if required:
            raise ApiError("Please choose one", field)
        return None
    try:
        return model.objects.get(user=user, pk=int(v))
    except (model.DoesNotExist, ValueError, TypeError):
        raise ApiError("Unknown option", field)


def p_text(v, field, max_len, required=False):
    s = (v or "").strip() if isinstance(v, str) else ("" if v is None else str(v).strip())
    if required and not s:
        raise ApiError("This field is required", field)
    return s[:max_len]


def p_bool(v):
    return v in (True, "true", "1", 1, "on")


def get_owned(model, user, pk):
    try:
        return model.objects.get(user=user, pk=pk)
    except model.DoesNotExist:
        raise ApiError("Not found", status=404)


def apply(obj, data, parsers):
    """Apply only the fields present in data (so PATCH works with partial bodies)."""
    for field, parse in parsers.items():
        if field in data:
            setattr(obj, field, parse(data[field]))


# --------------------------------------------------------------------------- bootstrap / sync

@api
def bootstrap(request):
    posted = services.process_due_recurring(request.user)
    data = services.lists_payload(request.user)
    data["recurring_posted"] = posted
    data["today"] = services.today().isoformat()
    return data


@api
def sync(request):
    return {"revision": services.get_profile(request.user).revision}


@api
def lists(request):
    return services.lists_payload(request.user)


@api
def dashboard(request):
    t = services.today()
    try:
        year = int(request.GET.get("year", t.year))
        month = int(request.GET.get("month", t.month))
        if not 1 <= month <= 12 or not 1900 < year < 3000:
            raise ValueError
    except ValueError:
        raise ApiError("Bad period")
    return services.dashboard(request.user, year, month)


@api
def year_view(request):
    try:
        year = int(request.GET.get("year", services.today().year))
    except ValueError:
        raise ApiError("Bad year")
    return services.year_view(request.user, year)


# --------------------------------------------------------------------------- transactions

def tx_parsers(user):
    return {
        "date": lambda v: p_date(v, "date"),
        "time": lambda v: p_time(v, "time"),
        "item": lambda v: p_text(v, "item", 200, required=True),
        "category": lambda v: p_fk(Category, user, v, "category"),
        "amount": lambda v: p_amount(v),
        "payment_method": lambda v: p_fk(PaymentMethod, user, v, "payment_method"),
        "notes": lambda v: p_text(v, "notes", 300),
    }


def filter_transactions(request):
    g = request.GET
    qs = Transaction.objects.filter(user=request.user).select_related("category", "payment_method")
    if g.get("from"):
        qs = qs.filter(date__gte=p_date(g["from"], "from"))
    if g.get("to"):
        qs = qs.filter(date__lte=p_date(g["to"], "to"))
    if g.get("q"):
        for word in g["q"].split():
            qs = qs.filter(Q(item__icontains=word) | Q(notes__icontains=word))
    if g.get("category"):
        cat = g["category"]
        qs = qs.filter(category__isnull=True) if cat == "none" else qs.filter(category_id=cat)
    if g.get("method"):
        qs = qs.filter(payment_method_id=g["method"])
    tf, tt = p_time(g.get("time_from"), "time_from"), p_time(g.get("time_to"), "time_to")
    if tf and tt and tf > tt:  # e.g. 10 PM -> 2 AM wraps past midnight
        qs = qs.filter(Q(time__gte=tf) | Q(time__lte=tt))
    else:
        if tf:
            qs = qs.filter(time__gte=tf)
        if tt:
            qs = qs.filter(time__lte=tt)
    if g.get("min"):
        qs = qs.filter(amount__gte=p_amount(g["min"], "min", allow_zero=True))
    if g.get("max"):
        qs = qs.filter(amount__lte=p_amount(g["max"], "max", allow_zero=True))
    return qs


SORTS = {
    "date": ["date", "time", "id"], "-date": ["-date", "-time", "-id"],
    "amount": ["amount", "-date"], "-amount": ["-amount", "-date"],
    "item": ["item", "-date"], "-item": ["-item", "-date"],
}


def paginate(request, qs, serializer):
    try:
        offset = max(int(request.GET.get("offset", 0)), 0)
        limit = min(max(int(request.GET.get("limit", 50)), 1), 500)
    except ValueError:
        offset, limit = 0, 50
    agg = qs.aggregate(total=Sum("amount"), count=Count("id"))
    rows = [serializer(o) for o in qs[offset:offset + limit]]
    return {
        "results": rows, "count": agg["count"], "total": float(agg["total"] or 0),
        "offset": offset, "has_more": offset + len(rows) < agg["count"],
    }


@api
@require_http_methods(["GET", "POST"])
def transactions(request):
    if request.method == "GET":
        qs = filter_transactions(request).order_by(*SORTS.get(request.GET.get("sort"), SORTS["-date"]))
        return paginate(request, qs, services.tx_dict)
    t = Transaction(user=request.user)
    data = request.data
    if "date" not in data:
        data["date"] = services.today().isoformat()
    for req in ("item", "amount"):
        data.setdefault(req, "")
    apply(t, data, tx_parsers(request.user))
    t.save()
    t = Transaction.objects.select_related("category", "payment_method").get(pk=t.pk)
    return {"item": services.tx_dict(t)}


@api
@require_http_methods(["GET", "PATCH", "PUT", "DELETE"])
def transaction_detail(request, pk):
    t = get_owned(Transaction, request.user, pk)
    if request.method == "DELETE":
        t.delete()
        return {"deleted": pk}
    if request.method in ("PATCH", "PUT"):
        apply(t, request.data, tx_parsers(request.user))
        t.save()
        t = Transaction.objects.select_related("category", "payment_method").get(pk=t.pk)
    return {"item": services.tx_dict(t)}


@api
@require_http_methods(["POST"])
def transactions_bulk_delete(request):
    ids = [int(i) for i in request.data.get("ids", []) if str(i).isdigit()]
    n, _ = Transaction.objects.filter(user=request.user, pk__in=ids).delete()
    return {"deleted": n}


@api
def suggest(request):
    """Autocomplete for the item field: remembers the last category/method/amount you used."""
    q = (request.GET.get("q") or "").strip()
    qs = Transaction.objects.filter(user=request.user)
    if q:
        qs = qs.filter(item__icontains=q)
    out = []
    for r in qs.values("item").annotate(n=Count("id"), last=Max("id")).order_by("-n", "-last")[:8]:
        last = Transaction.objects.get(pk=r["last"])
        out.append({
            "item": r["item"], "uses": r["n"], "category_id": last.category_id,
            "payment_method_id": last.payment_method_id, "amount": float(last.amount),
        })
    return out


# --------------------------------------------------------------------------- income

def income_parsers(user):
    return {
        "date": lambda v: p_date(v, "date"),
        "source": lambda v: p_fk(IncomeSource, user, v, "source"),
        "description": lambda v: p_text(v, "description", 200),
        "amount": lambda v: p_amount(v),
        "received_via": lambda v: p_fk(PaymentMethod, user, v, "received_via"),
        "notes": lambda v: p_text(v, "notes", 300),
    }


@api
@require_http_methods(["GET", "POST"])
def income(request):
    if request.method == "GET":
        g = request.GET
        qs = Income.objects.filter(user=request.user).select_related("source", "received_via")
        if g.get("from"):
            qs = qs.filter(date__gte=p_date(g["from"], "from"))
        if g.get("to"):
            qs = qs.filter(date__lte=p_date(g["to"], "to"))
        if g.get("source"):
            qs = qs.filter(source_id=g["source"])
        if g.get("q"):
            qs = qs.filter(Q(description__icontains=g["q"]) | Q(notes__icontains=g["q"]))
        sort = {"amount": ["amount"], "-amount": ["-amount"], "date": ["date", "id"]}.get(
            g.get("sort"), ["-date", "-id"]
        )
        return paginate(request, qs.order_by(*sort), services.income_dict)
    i = Income(user=request.user)
    data = request.data
    data.setdefault("date", services.today().isoformat())
    data.setdefault("amount", "")
    apply(i, data, income_parsers(request.user))
    i.save()
    i = Income.objects.select_related("source", "received_via").get(pk=i.pk)
    return {"item": services.income_dict(i)}


@api
@require_http_methods(["GET", "PATCH", "PUT", "DELETE"])
def income_detail(request, pk):
    i = get_owned(Income, request.user, pk)
    if request.method == "DELETE":
        i.delete()
        return {"deleted": pk}
    if request.method in ("PATCH", "PUT"):
        apply(i, request.data, income_parsers(request.user))
        i.save()
        i = Income.objects.select_related("source", "received_via").get(pk=i.pk)
    return {"item": services.income_dict(i)}


# --------------------------------------------------------------------------- budgets

def budget_parsers(user):
    def period(v):
        if v not in dict(Budget.PERIODS):
            raise ApiError("Choose Daily, Weekly or Monthly", "period")
        return v

    return {
        "category": lambda v: p_fk(Category, user, v, "category", required=True),
        "period": period,
        "amount": lambda v: p_amount(v),
        "starts": lambda v: p_date(v, "starts", required=False),
        "ends": lambda v: p_date(v, "ends", required=False),
    }


def check_budget(b):
    if b.starts and b.ends and b.ends < b.starts:
        raise ApiError("End date is before the start date", "ends")


@api
@require_http_methods(["GET", "POST"])
def budgets(request):
    if request.method == "GET":
        return [services.budget_dict(b) for b in Budget.objects.filter(user=request.user).select_related("category")]
    b = Budget(user=request.user)
    data = request.data
    data.setdefault("category", "")
    data.setdefault("amount", "")
    data.setdefault("period", Budget.MONTHLY)
    apply(b, data, budget_parsers(request.user))
    check_budget(b)
    b.save()
    return {"item": services.budget_dict(b)}


@api
@require_http_methods(["PATCH", "PUT", "DELETE"])
def budget_detail(request, pk):
    b = get_owned(Budget, request.user, pk)
    if request.method == "DELETE":
        b.delete()
        return {"deleted": pk}
    apply(b, request.data, budget_parsers(request.user))
    check_budget(b)
    b.save()
    return {"item": services.budget_dict(b)}


# --------------------------------------------------------------------------- goals

GOAL_PARSERS = {
    "name": lambda v: p_text(v, "name", 120, required=True),
    "icon": lambda v: p_text(v, "icon", 16) or "🎯",
    "color": lambda v: p_text(v, "color", 9) or "#6366f1",
    "target": lambda v: p_amount(v, "target"),
    "saved": lambda v: p_amount(v, "saved", allow_zero=True),
    "deadline": lambda v: p_date(v, "deadline", required=False),
}


@api
@require_http_methods(["GET", "POST"])
def goals(request):
    if request.method == "GET":
        return [services.goal_dict(g) for g in Goal.objects.filter(user=request.user)]
    g = Goal(user=request.user)
    data = request.data
    data.setdefault("name", "")
    data.setdefault("target", "")
    apply(g, data, GOAL_PARSERS)
    g.save()
    return {"item": services.goal_dict(g)}


@api
@require_http_methods(["PATCH", "PUT", "DELETE"])
def goal_detail(request, pk):
    g = get_owned(Goal, request.user, pk)
    if request.method == "DELETE":
        g.delete()
        return {"deleted": pk}
    apply(g, request.data, GOAL_PARSERS)
    g.save()
    return {"item": services.goal_dict(g)}


@api
@require_http_methods(["POST"])
def goal_contribute(request, pk):
    """Add (or withdraw, with a negative amount) money to a goal; optionally log it as spending."""
    g = get_owned(Goal, request.user, pk)
    raw = str(request.data.get("amount", "")).strip()
    withdraw = raw.startswith("-")
    amt = p_amount(raw.lstrip("-"))
    g.saved = max(g.saved - amt, Decimal("0")) if withdraw else g.saved + amt
    g.save()
    if p_bool(request.data.get("log_transaction")) and not withdraw:
        Transaction.objects.create(
            user=request.user, date=services.today(), item=f"Savings: {g.name}", amount=amt,
            category=p_fk(Category, request.user, request.data.get("category"), "category"),
            notes="Goal contribution",
        )
    return {"item": services.goal_dict(g)}


# --------------------------------------------------------------------------- recurring

def recurring_parsers(user):
    def choice(choices, field):
        def parse(v):
            if v not in dict(choices):
                raise ApiError("Invalid choice", field)
            return v
        return parse

    return {
        "kind": choice(Recurring.KINDS, "kind"),
        "name": lambda v: p_text(v, "name", 200, required=True),
        "amount": lambda v: p_amount(v),
        "category": lambda v: p_fk(Category, user, v, "category"),
        "source": lambda v: p_fk(IncomeSource, user, v, "source"),
        "payment_method": lambda v: p_fk(PaymentMethod, user, v, "payment_method"),
        "frequency": choice(Recurring.FREQS, "frequency"),
        "next_date": lambda v: p_date(v, "next_date"),
        "auto_post": p_bool,
        "active": p_bool,
    }


def rec_qs(user):
    return Recurring.objects.filter(user=user).select_related("category", "source", "payment_method")


@api
@require_http_methods(["GET", "POST"])
def recurring(request):
    if request.method == "GET":
        return [services.recurring_dict(r) for r in rec_qs(request.user)]
    r = Recurring(user=request.user)
    data = request.data
    data.setdefault("name", "")
    data.setdefault("amount", "")
    data.setdefault("next_date", services.today().isoformat())
    apply(r, data, recurring_parsers(request.user))
    r.save()
    services.process_due_recurring(request.user)
    return {"item": services.recurring_dict(rec_qs(request.user).get(pk=r.pk))}


@api
@require_http_methods(["PATCH", "PUT", "DELETE"])
def recurring_detail(request, pk):
    r = get_owned(Recurring, request.user, pk)
    if request.method == "DELETE":
        r.delete()
        return {"deleted": pk}
    apply(r, request.data, recurring_parsers(request.user))
    r.save()
    services.process_due_recurring(request.user)
    return {"item": services.recurring_dict(rec_qs(request.user).get(pk=r.pk))}


@api
@require_http_methods(["POST"])
def recurring_post_now(request, pk):
    """Record this occurrence now (for items that are not auto-posted) and move to the next date."""
    r = get_owned(Recurring, request.user, pk)
    services.post_recurring(r, services.today())
    r.next_date = services.advance(r.next_date, r.frequency)
    r.save(update_fields=["next_date"])
    return {"item": services.recurring_dict(rec_qs(request.user).get(pk=r.pk))}


# --------------------------------------------------------------------------- settings / lists

LIST_MODELS = {"categories": Category, "methods": PaymentMethod, "sources": IncomeSource}


@api
@require_http_methods(["POST"])
def list_create(request, kind):
    model = LIST_MODELS.get(kind)
    if not model:
        raise ApiError("Unknown list", status=404)
    name = p_text(request.data.get("name"), "name", 80, required=True)
    obj = model(user=request.user, name=name)
    obj.order = (model.objects.filter(user=request.user).aggregate(m=Max("order"))["m"] or 0) + 1
    if model is Category:
        obj.icon = p_text(request.data.get("icon"), "icon", 16) or "📦"
        obj.color = p_text(request.data.get("color"), "color", 9) or "#94a3b8"
    try:
        with transaction.atomic():
            obj.save()
    except IntegrityError:
        raise ApiError("That name already exists", "name")
    return {"lists": services.lists_payload(request.user)}


@api
@require_http_methods(["PATCH", "DELETE"])
def list_detail(request, kind, pk):
    model = LIST_MODELS.get(kind)
    if not model:
        raise ApiError("Unknown list", status=404)
    obj = get_owned(model, request.user, pk)
    if request.method == "DELETE":
        obj.delete()  # transactions keep their data; the link becomes empty
        return {"lists": services.lists_payload(request.user)}
    d = request.data
    if "name" in d:
        obj.name = p_text(d["name"], "name", 80, required=True)
    if "archived" in d:
        obj.archived = p_bool(d["archived"])
    if "order" in d:
        obj.order = int(d["order"])
    if model is Category:
        if "icon" in d:
            obj.icon = p_text(d["icon"], "icon", 16) or "📦"
        if "color" in d:
            obj.color = p_text(d["color"], "color", 9) or "#94a3b8"
    try:
        with transaction.atomic():
            obj.save()
    except IntegrityError:
        raise ApiError("That name already exists", "name")
    return {"lists": services.lists_payload(request.user)}


@api
@require_http_methods(["POST"])
def list_reorder(request, kind):
    model = LIST_MODELS.get(kind)
    if not model:
        raise ApiError("Unknown list", status=404)
    for idx, pk in enumerate(request.data.get("ids", [])):
        model.objects.filter(user=request.user, pk=pk).update(order=idx)
    return {"lists": services.lists_payload(request.user)}


@api
@require_http_methods(["PATCH"])
def settings_update(request):
    p = services.get_profile(request.user)
    d = request.data
    if "currency" in d:
        p.currency = p_text(d["currency"], "currency", 8, required=True).upper()
    if "warn_pct" in d:
        try:
            w = Decimal(str(d["warn_pct"]))
        except InvalidOperation:
            raise ApiError("Enter a percentage", "warn_pct")
        if w > 1:
            w = w / 100
        if not Decimal("0.1") <= w <= Decimal("1"):
            raise ApiError("Pick a level between 10% and 100%", "warn_pct")
        p.warn_pct = w.quantize(Decimal("0.01"))
    p.save()
    return {"lists": services.lists_payload(request.user)}


# --------------------------------------------------------------------------- import

@api
@require_http_methods(["POST"])
def import_file(request):
    f = request.FILES.get("file")
    if not f:
        raise ApiError("Choose a file to import", "file")
    try:
        if f.name.lower().endswith(".csv"):
            summary = dataio.import_csv(request.user, f, request.POST.get("kind", "transactions"))
        else:
            summary = dataio.import_workbook(request.user, f)
    except dataio.ImportProblem as e:
        raise ApiError(str(e), "file")
    return {"summary": summary}
