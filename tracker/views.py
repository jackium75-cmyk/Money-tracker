from django.contrib.auth import login
from django.contrib.auth.decorators import login_required
from django.contrib.auth.forms import UserCreationForm
from django.http import HttpResponse
from django.shortcuts import redirect, render

from . import dataio, services
from .api import filter_transactions


@login_required
def app(request):
    services.seed_defaults(request.user)
    return render(request, "tracker/app.html")


def signup(request):
    if request.user.is_authenticated:
        return redirect("app")
    form = UserCreationForm(request.POST or None)
    if request.method == "POST" and form.is_valid():
        user = form.save()
        services.seed_defaults(user)
        login(request, user)
        return redirect("app")
    return render(request, "registration/signup.html", {"form": form})


def _download(content, filename, content_type):
    resp = HttpResponse(content, content_type=content_type)
    resp["Content-Disposition"] = f'attachment; filename="{filename}"'
    return resp


@login_required
def export_transactions(request):
    # Honour the same filters as the Transactions/Search tab so "export what I see" works.
    qs = filter_transactions(request)
    return _download(dataio.transactions_csv(request.user, qs), "transactions.csv", "text/csv")


@login_required
def export_income(request):
    return _download(dataio.income_csv(request.user), "income.csv", "text/csv")


@login_required
def export_workbook(request):
    return _download(
        dataio.workbook_bytes(request.user),
        f"money-tracker-{services.today():%Y-%m-%d}.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
