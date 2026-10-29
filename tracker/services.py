"""Business logic: the Dashboard / Year View maths from the Money Tracker workbook."""
import calendar
from collections import defaultdict
from datetime import date, timedelta

from django.db import transaction as db_transaction
from django.db.models import Count, F, Sum
from django.utils import timezone

from .models import (
    DEFAULT_CATEGORIES,
    DEFAULT_INCOME_SOURCES,
    DEFAULT_PAYMENT_METHODS,
    Budget,
    Category,
    Income,
    IncomeSource,
    PaymentMethod,
    Profile,
    Recurring,
    Transaction,
)

MONTHS = list(calendar.month_name)[1:]


def today():
    return timezone.localdate()


def get_profile(user):
    profile, _ = Profile.objects.get_or_create(user=user)
    return profile


def bump_revision(user):
    Profile.objects.filter(user=user).update(revision=F("revision") + 1)


@db_transaction.atomic
def seed_defaults(user):
    get_profile(user)
    if not Category.objects.filter(user=user).exists():
        Category.objects.bulk_create(
            Category(user=user, name=n, icon=i, color=c, order=idx)
            for idx, (n, i, c) in enumerate(DEFAULT_CATEGORIES)
        )
    if not PaymentMethod.objects.filter(user=user).exists():
        PaymentMethod.objects.bulk_create(
            PaymentMethod(user=user, name=n, order=idx)
            for idx, n in enumerate(DEFAULT_PAYMENT_METHODS)
        )
    if not IncomeSource.objects.filter(user=user).exists():
        IncomeSource.objects.bulk_create(
            IncomeSource(user=user, name=n, order=idx)
            for idx, n in enumerate(DEFAULT_INCOME_SOURCES)
        )


# --------------------------------------------------------------------------- recurring

def advance(d, freq):
    if freq == Recurring.WEEKLY:
        return d + timedelta(days=7)
    if freq == Recurring.YEARLY:
        try:
            return d.replace(year=d.year + 1)
        except ValueError:  # 29 Feb
            return d.replace(year=d.year + 1, day=28)
    month = d.month % 12 + 1
    year = d.year + (1 if d.month == 12 else 0)
    return d.replace(year=year, month=month, day=min(d.day, calendar.monthrange(year, month)[1]))


def post_recurring(rec, on_date=None):
    on_date = on_date or rec.next_date
    if rec.kind == Recurring.EXPENSE:
        return Transaction.objects.create(
            user=rec.user, date=on_date, item=rec.name, category=rec.category,
            amount=rec.amount, payment_method=rec.payment_method, notes="Recurring",
        )
    return Income.objects.create(
        user=rec.user, date=on_date, source=rec.source, description=rec.name,
        amount=rec.amount, received_via=rec.payment_method, notes="Recurring",
    )


@db_transaction.atomic
def process_due_recurring(user):
    """Post every auto-post recurring item that has fallen due. Returns count posted."""
    posted = 0
    now = today()
    for rec in Recurring.objects.select_for_update().filter(
        user=user, active=True, auto_post=True, next_date__lte=now
    ):
        guard = 0
        while rec.next_date <= now and guard < 400:
            post_recurring(rec)
            rec.next_date = advance(rec.next_date, rec.frequency)
            posted += 1
            guard += 1
        rec.save(update_fields=["next_date"])
    if posted:
        bump_revision(user)
    return posted


# --------------------------------------------------------------------------- helpers

def status_for(spent, budget, warn):
    if budget == 0:
        return "No budget" if spent > 0 else "-"
    if spent > budget:
        return "OVER"
    if spent >= warn * budget:
        return "Watch"
    return "OK"


def month_bounds(year, month):
    dim = calendar.monthrange(year, month)[1]
    return date(year, month, 1), date(year, month, dim), dim


def category_budgets(user, start, end, dim):
    totals = defaultdict(float)
    for b in Budget.objects.filter(user=user):
        totals[b.category_id] += b.amount_for_month(start, end, dim)
    return totals


def fmt(n):
    return f"{n:,.0f}"


def plural_cats(n):
    if not n:
        return ""
    return f" Watch out: {n} {'category is' if n == 1 else 'categories are'} over its own budget."


# --------------------------------------------------------------------------- dashboard

def dashboard(user, year, month):
    profile = get_profile(user)
    warn = float(profile.warn_pct)
    cur = profile.currency
    start, end, dim = month_bounds(year, month)
    now = today()
    is_current = start <= now <= end
    if now < start:
        elapsed = 0
    elif now > end:
        elapsed = dim
    else:
        elapsed = (now - start).days + 1
    days_left = dim - elapsed

    txs = Transaction.objects.filter(user=user, date__range=(start, end))
    incs = Income.objects.filter(user=user, date__range=(start, end))

    spent = float(txs.aggregate(s=Sum("amount"))["s"] or 0)
    income = float(incs.aggregate(s=Sum("amount"))["s"] or 0)
    tx_count = txs.count()
    inc_count = incs.count()

    cats = list(Category.objects.filter(user=user))
    cat_budget = category_budgets(user, start, end, dim)
    spent_by_cat = {
        r["category_id"]: float(r["s"])
        for r in txs.values("category_id").annotate(s=Sum("amount"))
    }
    count_by_cat = {
        r["category_id"]: r["n"] for r in txs.values("category_id").annotate(n=Count("id"))
    }

    categories = []
    for c in cats:
        b = cat_budget.get(c.id, 0.0)
        s = spent_by_cat.get(c.id, 0.0)
        if c.archived and not b and not s:
            continue
        categories.append({
            "id": c.id, "name": c.name, "icon": c.icon, "color": c.color,
            "budget": b, "spent": s, "remaining": b - s,
            "pct": (s / b) if b else 0, "status": status_for(s, b, warn),
            "count": count_by_cat.get(c.id, 0),
        })
    if spent_by_cat.get(None):
        s = spent_by_cat[None]
        categories.append({
            "id": None, "name": "Uncategorised", "icon": "❔", "color": "#cbd5e1",
            "budget": 0, "spent": s, "remaining": -s, "pct": 0,
            "status": "No budget", "count": count_by_cat.get(None, 0),
        })

    total_budget = sum(c["budget"] for c in categories)
    budget_used = spent / total_budget if total_budget else 0
    if not total_budget:
        status = "NO BUDGET"
    elif spent > total_budget:
        status = "OVERSPENDING"
    elif budget_used >= warn:
        status = "WATCH OUT"
    else:
        status = "ON TRACK"

    # Spending health (pace) - same rules as the workbook's Dashboard!C13:C22
    remaining = total_budget - spent
    if is_current:
        expected = total_budget * elapsed / dim
        projected = (spent / elapsed * dim) if elapsed else 0
    else:
        expected = total_budget if end < now else 0
        projected = spent
    ahead = spent - expected if total_budget else 0
    proj_over = projected - total_budget if total_budget else 0
    safe_per_day = max(remaining, 0) / days_left if is_current and days_left > 0 else 0
    avg_per_day = spent / elapsed if elapsed else 0
    cats_over = sum(1 for c in categories if c["status"] == "OVER")

    if not total_budget:
        banner = ("info", "No budget set yet - add your budgets on the Budget tab to switch on overspending alerts.")
    elif spent > total_budget:
        banner = ("danger", f"OVERSPENDING: you have spent {cur} {fmt(spent - total_budget)} more than your total budget for this period." + plural_cats(cats_over))
    elif is_current and expected > 0 and ahead > 0.1 * expected:
        banner = ("warn", f"HEADS UP: you are spending faster than planned. At this pace you will finish near {cur} {fmt(projected)} against a budget of {cur} {fmt(total_budget)}." + plural_cats(cats_over))
    else:
        msg = "ON TRACK: you are within budget."
        if is_current:
            msg += f" You can spend about {cur} {fmt(safe_per_day)} per day for the rest of the month."
        banner = ("warn" if cats_over else "ok", msg + plural_cats(cats_over))

    if is_current:
        period_note = f"Current month: day {elapsed} of {dim} ({days_left} days to go)"
    elif end < now:
        period_note = "Past month - full results"
    else:
        period_note = "Future month - nothing to analyse yet"

    # Daily
    by_day = {r["date"]: float(r["s"]) for r in txs.values("date").annotate(s=Sum("amount"))}
    inc_by_day = {r["date"]: float(r["s"]) for r in incs.values("date").annotate(s=Sum("amount"))}
    allowance = total_budget / dim if total_budget else 0
    daily = []
    for i in range(dim):
        d = start + timedelta(days=i)
        s = by_day.get(d, 0.0)
        if d > now:
            st = "-"
        elif allowance == 0:
            st = "No budget" if s > 0 else "-"
        elif s > allowance:
            st = "OVER"
        elif s == 0:
            st = "No spend"
        else:
            st = "OK"
        daily.append({
            "date": d.isoformat(), "day": d.strftime("%a"), "spent": s,
            "income": inc_by_day.get(d, 0.0), "allowance": allowance, "status": st,
        })

    # Weekly (7-day blocks from the 1st, like the workbook)
    weeks = []
    for w in range(5):
        ws = start + timedelta(days=7 * w)
        if ws > end:
            break
        we = min(end, ws + timedelta(days=6))
        s = sum(by_day.get(ws + timedelta(days=k), 0.0) for k in range((we - ws).days + 1))
        b = total_budget * ((we - ws).days + 1) / dim
        st = "Upcoming" if ws > now else status_for(s, b, warn)
        weeks.append({
            "label": f"Week {w + 1}", "dates": f"{ws.day} {ws:%b} - {we.day} {we:%b}",
            "spent": s, "budget": b, "status": st,
        })

    def share_rows(qs, field, label_field, total):
        rows = []
        for r in qs.values(field, label_field).annotate(s=Sum("amount")).order_by("-s"):
            rows.append({
                "name": r[label_field] or "Unspecified", "amount": float(r["s"]),
                "share": float(r["s"]) / total if total else 0,
            })
        return rows

    by_source = share_rows(incs, "source_id", "source__name", income)
    by_method = share_rows(txs, "payment_method_id", "payment_method__name", spent)

    top = [tx_dict(t) for t in txs.select_related("category", "payment_method").order_by("-amount", "-date")[:5]]

    # Insights
    prev_start = (start - timedelta(days=1)).replace(day=1)
    prev_end = start - timedelta(days=1)
    prev_spent = float(
        Transaction.objects.filter(user=user, date__range=(prev_start, prev_end)).aggregate(s=Sum("amount"))["s"] or 0
    )
    prev_income = float(
        Income.objects.filter(user=user, date__range=(prev_start, prev_end)).aggregate(s=Sum("amount"))["s"] or 0
    )
    weekday = [0.0] * 7
    for d, s in by_day.items():
        weekday[d.weekday()] += s
    hours = [0.0] * 24
    for r in txs.exclude(time=None).values("time", "amount"):
        hours[r["time"].hour] += float(r["amount"])
    top_items = [
        {"item": r["item"], "count": r["n"], "amount": float(r["s"])}
        for r in txs.values("item").annotate(n=Count("id"), s=Sum("amount")).order_by("-n", "-s")[:5]
    ]
    no_spend_days = sum(1 for d in daily if d["status"] == "No spend")
    biggest_cat = max(categories, key=lambda c: c["spent"], default=None)

    upcoming = [
        {"id": r.id, "name": r.name, "amount": float(r.amount), "kind": r.kind,
         "next_date": r.next_date.isoformat(), "auto_post": r.auto_post}
        for r in Recurring.objects.filter(user=user, active=True, next_date__gte=now)
        .order_by("next_date")[:5]
    ]

    return {
        "year": year, "month": month, "month_name": MONTHS[month - 1],
        "start": start.isoformat(), "end": end.isoformat(),
        "is_current": is_current, "days_in_month": dim, "days_elapsed": elapsed, "days_left": days_left,
        "period_note": period_note,
        "kpi": {
            "income": income, "income_count": inc_count, "spent": spent, "tx_count": tx_count,
            "net": income - spent,
            "savings_rate": (income - spent) / income if income else 0,
            "budget": total_budget, "budget_used": budget_used, "status": status,
        },
        "banner": {"level": banner[0], "text": banner[1]},
        "health": {
            "budget": total_budget, "spent": spent, "remaining": remaining,
            "expected": expected, "ahead": ahead, "projected": projected,
            "projected_over": proj_over, "safe_per_day": safe_per_day,
            "avg_per_day": avg_per_day, "cats_over": cats_over,
        },
        "weeks": weeks,
        "categories": categories,
        "by_source": by_source,
        "by_method": by_method,
        "top": top,
        "daily": daily,
        "insights": {
            "prev_spent": prev_spent, "prev_income": prev_income,
            "spent_change": (spent - prev_spent) / prev_spent if prev_spent else None,
            "income_change": (income - prev_income) / prev_income if prev_income else None,
            "weekday": weekday, "hours": hours, "top_items": top_items,
            "no_spend_days": no_spend_days,
            "biggest_category": biggest_cat["name"] if biggest_cat and biggest_cat["spent"] else None,
            "largest": top[0] if top else None,
        },
        "upcoming": upcoming,
    }


def year_view(user, year):
    warn = float(get_profile(user).warn_pct)
    rows = []
    budgets = list(Budget.objects.filter(user=user))
    inc = {
        r["date__month"]: float(r["s"])
        for r in Income.objects.filter(user=user, date__year=year).values("date__month").annotate(s=Sum("amount"))
    }
    spn = {
        r["date__month"]: float(r["s"])
        for r in Transaction.objects.filter(user=user, date__year=year).values("date__month").annotate(s=Sum("amount"))
    }
    for m in range(1, 13):
        start, end, dim = month_bounds(year, m)
        b = sum(x.amount_for_month(start, end, dim) for x in budgets)
        i, s = inc.get(m, 0.0), spn.get(m, 0.0)
        rows.append({
            "month": m, "name": MONTHS[m - 1], "income": i, "spent": s, "net": i - s,
            "savings_rate": (i - s) / i if i else 0, "budget": b,
            "budget_used": s / b if b else 0,
            "status": "-" if not s and not b else status_for(s, b, warn),
        })
    ti = sum(r["income"] for r in rows)
    ts = sum(r["spent"] for r in rows)
    tb = sum(r["budget"] for r in rows)
    total = {
        "income": ti, "spent": ts, "net": ti - ts, "savings_rate": (ti - ts) / ti if ti else 0,
        "budget": tb, "budget_used": ts / tb if tb else 0,
        "status": "-" if not ts and not tb else status_for(ts, tb, warn),
    }
    cat_rows = []
    for r in (
        Transaction.objects.filter(user=user, date__year=year)
        .values("category__name", "category__color", "category__icon", "date__month")
        .annotate(s=Sum("amount"))
    ):
        cat_rows.append({
            "name": r["category__name"] or "Uncategorised", "color": r["category__color"] or "#cbd5e1",
            "icon": r["category__icon"] or "❔", "month": r["date__month"], "amount": float(r["s"]),
        })
    return {"year": year, "months": rows, "total": total, "category_months": cat_rows}


# --------------------------------------------------------------------------- serializers

def tx_dict(t):
    return {
        "id": t.id, "date": t.date.isoformat(),
        "time": t.time.strftime("%H:%M") if t.time else "",
        "item": t.item, "amount": float(t.amount), "notes": t.notes,
        "category_id": t.category_id,
        "category": t.category.name if t.category else "",
        "category_icon": t.category.icon if t.category else "❔",
        "category_color": t.category.color if t.category else "#cbd5e1",
        "payment_method_id": t.payment_method_id,
        "payment_method": t.payment_method.name if t.payment_method else "",
    }


def income_dict(i):
    return {
        "id": i.id, "date": i.date.isoformat(), "amount": float(i.amount),
        "description": i.description, "notes": i.notes,
        "source_id": i.source_id, "source": i.source.name if i.source else "",
        "received_via_id": i.received_via_id,
        "received_via": i.received_via.name if i.received_via else "",
    }


def budget_dict(b):
    pd = b.per_day()
    return {
        "id": b.id, "category_id": b.category_id, "category": b.category.name,
        "category_icon": b.category.icon, "category_color": b.category.color,
        "period": b.period, "amount": float(b.amount),
        "starts": b.starts.isoformat() if b.starts else "",
        "ends": b.ends.isoformat() if b.ends else "",
        "per_day": pd, "per_week": pd * 7, "per_month": pd * 365 / 12,
    }


def goal_dict(g):
    target, saved = float(g.target), float(g.saved)
    out = {
        "id": g.id, "name": g.name, "icon": g.icon, "color": g.color,
        "target": target, "saved": saved, "pct": saved / target if target else 0,
        "deadline": g.deadline.isoformat() if g.deadline else "", "per_month_needed": None,
        "days_left": None,
    }
    if g.deadline:
        days = (g.deadline - today()).days
        out["days_left"] = days
        months = max(days / 30.44, 1)
        out["per_month_needed"] = max(target - saved, 0) / months
    return out


def recurring_dict(r):
    return {
        "id": r.id, "kind": r.kind, "name": r.name, "amount": float(r.amount),
        "category_id": r.category_id, "category": r.category.name if r.category else "",
        "source_id": r.source_id, "source": r.source.name if r.source else "",
        "payment_method_id": r.payment_method_id,
        "payment_method": r.payment_method.name if r.payment_method else "",
        "frequency": r.frequency, "next_date": r.next_date.isoformat(),
        "auto_post": r.auto_post, "active": r.active,
    }


def lists_payload(user):
    profile = get_profile(user)
    tx_counts = dict(
        Transaction.objects.filter(user=user).values_list("category_id").annotate(n=Count("id"))
    )
    return {
        "currency": profile.currency,
        "warn_pct": float(profile.warn_pct),
        "revision": profile.revision,
        "username": user.get_username(),
        "categories": [
            {"id": c.id, "name": c.name, "icon": c.icon, "color": c.color,
             "archived": c.archived, "order": c.order, "uses": tx_counts.get(c.id, 0)}
            for c in Category.objects.filter(user=user)
        ],
        "payment_methods": [
            {"id": m.id, "name": m.name, "archived": m.archived, "order": m.order}
            for m in PaymentMethod.objects.filter(user=user)
        ],
        "income_sources": [
            {"id": s.id, "name": s.name, "archived": s.archived, "order": s.order}
            for s in IncomeSource.objects.filter(user=user)
        ],
        "years": sorted(
            {d.year for d in Transaction.objects.filter(user=user).dates("date", "year")}
            | {d.year for d in Income.objects.filter(user=user).dates("date", "year")}
            | {today().year}
        ),
    }
