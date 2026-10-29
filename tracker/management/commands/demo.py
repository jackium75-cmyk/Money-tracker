import random
from datetime import time, timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand

from tracker import services
from tracker.models import (
    Budget,
    Category,
    Goal,
    Income,
    IncomeSource,
    PaymentMethod,
    Recurring,
    Transaction,
)

SPENDS = [
    ("Food & Groceries", ["Naivas groceries", "Carrefour shopping", "Mama mboga veggies", "Milk & bread"], (150, 2200), 0.65),
    ("Eating Out", ["Lunch at Java House", "KFC", "Chapati & beans", "Coffee"], (200, 900), 0.35),
    ("Transport & Fuel", ["Matatu fare", "Uber to town", "Fuel - Shell", "Boda boda"], (80, 700), 0.85),
    ("Airtime & Data", ["Safaricom data bundle", "Airtime"], (50, 500), 0.25),
    ("Utilities", ["KPLC tokens", "Water bill"], (500, 2500), 0.08),
    ("Entertainment & Leisure", ["Showmax", "Movie night", "Weekend outing"], (300, 2000), 0.1),
    ("Shopping & Clothing", ["Shoes", "T-shirt", "Toiletries"], (400, 4000), 0.08),
    ("Health & Medical", ["Pharmacy", "Clinic visit"], (300, 3500), 0.05),
    ("Personal Care", ["Haircut", "Salon"], (300, 1500), 0.06),
    ("Giving & Church", ["Church offering"], (200, 1000), 0.14),
    ("Family & Support", ["Send to mum"], (1000, 5000), 0.05),
]
BUDGETS = [
    ("Food & Groceries", "Monthly", 18000), ("Eating Out", "Weekly", 1500),
    ("Rent & Housing", "Monthly", 25000), ("Utilities", "Monthly", 4000),
    ("Transport & Fuel", "Daily", 350), ("Airtime & Data", "Monthly", 2000),
    ("Entertainment & Leisure", "Monthly", 4000), ("Shopping & Clothing", "Monthly", 5000),
    ("Health & Medical", "Monthly", 3000), ("Personal Care", "Monthly", 2000),
    ("Giving & Church", "Monthly", 3000), ("Family & Support", "Monthly", 5000),
]


class Command(BaseCommand):
    help = "Create a demo user with ~3 months of realistic sample data."

    def add_arguments(self, parser):
        parser.add_argument("--username", default="demo")
        parser.add_argument("--password", default="demo12345")
        parser.add_argument("--months", type=int, default=3)

    def handle(self, *args, **opts):
        User = get_user_model()
        user, created = User.objects.get_or_create(username=opts["username"])
        user.set_password(opts["password"])
        user.save()
        for model in (Transaction, Income, Budget, Goal, Recurring):
            model.objects.filter(user=user).delete()
        services.seed_defaults(user)
        rnd = random.Random(42)
        cats = {c.name: c for c in Category.objects.filter(user=user)}
        methods = {m.name: m for m in PaymentMethod.objects.filter(user=user)}
        sources = {s.name: s for s in IncomeSource.objects.filter(user=user)}
        today = services.today()
        start = (today.replace(day=1) - timedelta(days=31 * (opts["months"] - 1))).replace(day=1)

        for name, period, amt in BUDGETS:
            Budget.objects.create(user=user, category=cats[name], period=period, amount=amt)

        txs, incs = [], []
        d = start
        while d <= today:
            if d.day == 1:
                txs.append(Transaction(user=user, date=d, time=time(9, 0), item="Rent", amount=25000,
                                       category=cats["Rent & Housing"], payment_method=methods["Bank Transfer"]))
            if d.day == 28:
                incs.append(Income(user=user, date=d, source=sources["Salary"], description="Monthly salary",
                                   amount=120000, received_via=methods["Bank Transfer"]))
            if d.day in (10, 22) and rnd.random() < 0.7:
                incs.append(Income(user=user, date=d, source=sources["Freelance / Client Project"],
                                   description="Website project", amount=rnd.choice([8000, 12000, 15000]),
                                   received_via=methods["M-Pesa"]))
            for cat, items, (lo, hi), p in SPENDS:
                if rnd.random() < p:
                    amt = Decimal(rnd.randrange(lo, hi, 10))
                    txs.append(Transaction(
                        user=user, date=d, time=time(rnd.randint(6, 22), rnd.choice([0, 15, 30, 45])),
                        item=rnd.choice(items), amount=amt, category=cats[cat],
                        payment_method=methods[rnd.choice(["M-Pesa", "M-Pesa", "M-Pesa", "Cash", "Bank Card"])],
                    ))
            d += timedelta(days=1)
        Transaction.objects.bulk_create(txs)
        Income.objects.bulk_create(incs)

        Goal.objects.create(user=user, name="Emergency fund", icon="🛟", target=150000, saved=62000,
                            deadline=today + timedelta(days=240), color="#10b981")
        Goal.objects.create(user=user, name="New laptop", icon="💻", target=95000, saved=30500,
                            deadline=today + timedelta(days=120), color="#6366f1")
        Recurring.objects.create(user=user, name="Netflix", amount=1100, category=cats["Entertainment & Leisure"],
                                 payment_method=methods["Bank Card"], frequency="monthly",
                                 next_date=today + timedelta(days=5))
        Recurring.objects.create(user=user, name="Chama contribution", amount=3000, category=cats["Loans & Debt"],
                                 payment_method=methods["M-Pesa"], frequency="monthly",
                                 next_date=today + timedelta(days=9), auto_post=False)
        services.bump_revision(user)
        self.stdout.write(self.style.SUCCESS(
            f"Demo user '{user.username}' ready: {len(txs)} transactions, {len(incs)} income entries. "
            f"Password: {opts['password']}"
        ))
