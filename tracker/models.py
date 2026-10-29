from decimal import Decimal

from django.conf import settings
from django.db import models

USER = settings.AUTH_USER_MODEL

# Defaults taken from the "Settings & Lists" sheet of the Money Tracker workbook.
DEFAULT_CATEGORIES = [
    ("Food & Groceries", "🛒", "#22c55e"),
    ("Eating Out", "🍔", "#f97316"),
    ("Rent & Housing", "🏠", "#6366f1"),
    ("Utilities", "💡", "#eab308"),
    ("Transport & Fuel", "🚗", "#0ea5e9"),
    ("Airtime & Data", "📱", "#14b8a6"),
    ("Health & Medical", "🩺", "#ef4444"),
    ("Education & School Fees", "🎓", "#8b5cf6"),
    ("Business Expenses", "💼", "#64748b"),
    ("Shopping & Clothing", "🛍️", "#ec4899"),
    ("Entertainment & Leisure", "🎬", "#a855f7"),
    ("Personal Care", "💅", "#f43f5e"),
    ("Family & Support", "👨‍👩‍👧", "#10b981"),
    ("Giving & Church", "⛪", "#d97706"),
    ("Loans & Debt", "🏦", "#b91c1c"),
    ("Other", "📦", "#94a3b8"),
]
DEFAULT_PAYMENT_METHODS = [
    "Cash", "M-Pesa", "Bank Card", "Bank Transfer", "Airtel Money", "Other",
]
DEFAULT_INCOME_SOURCES = [
    "Salary", "Business Income", "Freelance / Client Project", "Side Hustle",
    "Gift / Support", "Interest & Dividends", "Rental Income", "Other Income",
]


class Profile(models.Model):
    user = models.OneToOneField(USER, on_delete=models.CASCADE, related_name="profile")
    currency = models.CharField(max_length=8, default="KES")
    warn_pct = models.DecimalField(
        max_digits=4, decimal_places=2, default=Decimal("0.80"),
        help_text="Budget share at which a category turns amber (Watch).",
    )
    # Bumped on every write; open browser tabs poll it to stay in sync live.
    revision = models.PositiveBigIntegerField(default=0)

    def __str__(self):
        return f"Profile({self.user})"


class OwnedNamed(models.Model):
    user = models.ForeignKey(USER, on_delete=models.CASCADE)
    name = models.CharField(max_length=80)
    order = models.PositiveIntegerField(default=0)
    archived = models.BooleanField(default=False)

    class Meta:
        abstract = True
        ordering = ["order", "name"]

    def __str__(self):
        return self.name


class Category(OwnedNamed):
    icon = models.CharField(max_length=16, default="📦")
    color = models.CharField(max_length=9, default="#94a3b8")

    class Meta(OwnedNamed.Meta):
        verbose_name_plural = "categories"
        constraints = [
            models.UniqueConstraint(fields=["user", "name"], name="uniq_category_name"),
        ]


class PaymentMethod(OwnedNamed):
    class Meta(OwnedNamed.Meta):
        constraints = [
            models.UniqueConstraint(fields=["user", "name"], name="uniq_method_name"),
        ]


class IncomeSource(OwnedNamed):
    class Meta(OwnedNamed.Meta):
        constraints = [
            models.UniqueConstraint(fields=["user", "name"], name="uniq_source_name"),
        ]


class Transaction(models.Model):
    user = models.ForeignKey(USER, on_delete=models.CASCADE)
    date = models.DateField(db_index=True)
    time = models.TimeField(null=True, blank=True)
    item = models.CharField("Item / Product", max_length=200)
    category = models.ForeignKey(Category, null=True, blank=True, on_delete=models.SET_NULL)
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    payment_method = models.ForeignKey(
        PaymentMethod, null=True, blank=True, on_delete=models.SET_NULL
    )
    notes = models.CharField(max_length=300, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-date", "-time", "-id"]

    def __str__(self):
        return f"{self.date} {self.item} {self.amount}"


class Income(models.Model):
    user = models.ForeignKey(USER, on_delete=models.CASCADE)
    date = models.DateField(db_index=True)
    source = models.ForeignKey(IncomeSource, null=True, blank=True, on_delete=models.SET_NULL)
    description = models.CharField(max_length=200, blank=True)
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    received_via = models.ForeignKey(
        PaymentMethod, null=True, blank=True, on_delete=models.SET_NULL
    )
    notes = models.CharField(max_length=300, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-date", "-id"]
        verbose_name_plural = "income"

    def __str__(self):
        return f"{self.date} {self.source} {self.amount}"


class Budget(models.Model):
    DAILY, WEEKLY, MONTHLY = "Daily", "Weekly", "Monthly"
    PERIODS = [(DAILY, "Daily"), (WEEKLY, "Weekly"), (MONTHLY, "Monthly")]

    user = models.ForeignKey(USER, on_delete=models.CASCADE)
    category = models.ForeignKey(Category, on_delete=models.CASCADE)
    period = models.CharField(max_length=10, choices=PERIODS, default=MONTHLY)
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    starts = models.DateField(null=True, blank=True)
    ends = models.DateField(null=True, blank=True)

    class Meta:
        ordering = ["category__order", "category__name", "starts"]

    def per_day(self):
        a = float(self.amount)
        if self.period == self.DAILY:
            return a
        if self.period == self.WEEKLY:
            return a / 7
        return a * 12 / 365

    def amount_for_month(self, start, end, days_in_month):
        """Same rule as the workbook: active if starts<=month end and (no end or end>=month start)."""
        if self.starts and self.starts > end:
            return 0.0
        if self.ends and self.ends < start:
            return 0.0
        a = float(self.amount)
        if self.period == self.DAILY:
            return a * days_in_month
        if self.period == self.WEEKLY:
            return a * days_in_month / 7
        return a


class Goal(models.Model):
    user = models.ForeignKey(USER, on_delete=models.CASCADE)
    name = models.CharField(max_length=120)
    icon = models.CharField(max_length=16, default="🎯")
    target = models.DecimalField(max_digits=14, decimal_places=2)
    saved = models.DecimalField(max_digits=14, decimal_places=2, default=0)
    deadline = models.DateField(null=True, blank=True)
    color = models.CharField(max_length=9, default="#6366f1")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["deadline", "id"]


class Recurring(models.Model):
    """A bill or income that repeats - posted automatically when it falls due."""

    EXPENSE, INCOME = "expense", "income"
    KINDS = [(EXPENSE, "Expense"), (INCOME, "Income")]
    WEEKLY, MONTHLY, YEARLY = "weekly", "monthly", "yearly"
    FREQS = [(WEEKLY, "Weekly"), (MONTHLY, "Monthly"), (YEARLY, "Yearly")]

    user = models.ForeignKey(USER, on_delete=models.CASCADE)
    kind = models.CharField(max_length=8, choices=KINDS, default=EXPENSE)
    name = models.CharField(max_length=200)
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    category = models.ForeignKey(Category, null=True, blank=True, on_delete=models.SET_NULL)
    source = models.ForeignKey(IncomeSource, null=True, blank=True, on_delete=models.SET_NULL)
    payment_method = models.ForeignKey(
        PaymentMethod, null=True, blank=True, on_delete=models.SET_NULL
    )
    frequency = models.CharField(max_length=8, choices=FREQS, default=MONTHLY)
    next_date = models.DateField()
    auto_post = models.BooleanField(default=True)
    active = models.BooleanField(default=True)

    class Meta:
        ordering = ["next_date", "id"]
