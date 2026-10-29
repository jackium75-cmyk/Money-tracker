from django.contrib import admin

from .models import (
    Budget,
    Category,
    Goal,
    Income,
    IncomeSource,
    PaymentMethod,
    Profile,
    Recurring,
    Transaction,
)


@admin.register(Transaction)
class TransactionAdmin(admin.ModelAdmin):
    list_display = ("date", "time", "item", "category", "amount", "payment_method", "user")
    list_filter = ("category", "payment_method", "date")
    search_fields = ("item", "notes")
    date_hierarchy = "date"


@admin.register(Income)
class IncomeAdmin(admin.ModelAdmin):
    list_display = ("date", "source", "description", "amount", "received_via", "user")
    list_filter = ("source",)
    date_hierarchy = "date"


@admin.register(Budget)
class BudgetAdmin(admin.ModelAdmin):
    list_display = ("category", "period", "amount", "starts", "ends", "user")


for model in (Category, PaymentMethod, IncomeSource, Goal, Recurring, Profile):
    admin.site.register(model)
