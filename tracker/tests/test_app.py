import io
import json
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

import openpyxl
from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase

from tracker import services
from tracker.models import Budget, Category, Income, Recurring, Transaction

HERE = Path(__file__).parent


class Base(TestCase):
    def setUp(self):
        self.user = User.objects.create_user("amina", password="pw-12345-xyz")
        services.seed_defaults(self.user)
        self.client.force_login(self.user)
        self.food = Category.objects.get(user=self.user, name="Food & Groceries")
        self.out = Category.objects.get(user=self.user, name="Eating Out")

    def j(self, method, url, body=None):
        fn = getattr(self.client, method)
        resp = fn(url, data=json.dumps(body or {}), content_type="application/json") if method != "get" else fn(url)
        return resp.status_code, resp.json()


class DashboardMathTests(Base):
    def test_budget_periods_scale_like_the_workbook(self):
        Budget.objects.create(user=self.user, category=self.food, period="Monthly", amount=10000)
        Budget.objects.create(user=self.user, category=self.out, period="Daily", amount=100)
        Budget.objects.create(user=self.user, category=self.out, period="Weekly", amount=700)
        with mock.patch.object(services, "today", return_value=date(2026, 10, 15)):
            d = services.dashboard(self.user, 2026, 10)
        cats = {c["name"]: c for c in d["categories"]}
        self.assertEqual(cats["Food & Groceries"]["budget"], 10000)
        # Daily 100 * 31 days + weekly 700 * 31/7
        self.assertAlmostEqual(cats["Eating Out"]["budget"], 3100 + 3100)
        self.assertAlmostEqual(d["kpi"]["budget"], 16200)

    def test_budget_start_and_end_dates(self):
        Budget.objects.create(user=self.user, category=self.food, period="Monthly", amount=5000, ends=date(2026, 9, 30))
        Budget.objects.create(user=self.user, category=self.food, period="Monthly", amount=8000, starts=date(2026, 10, 1))
        sept = services.dashboard(self.user, 2026, 9)["kpi"]["budget"]
        octo = services.dashboard(self.user, 2026, 10)["kpi"]["budget"]
        self.assertEqual((sept, octo), (5000, 8000))

    def test_status_pace_and_alerts(self):
        Budget.objects.create(user=self.user, category=self.food, period="Monthly", amount=3100)
        Transaction.objects.create(user=self.user, date=date(2026, 10, 2), item="Naivas", category=self.food, amount=3500)
        Income.objects.create(user=self.user, date=date(2026, 10, 1), amount=10000)
        with mock.patch.object(services, "today", return_value=date(2026, 10, 10)):
            d = services.dashboard(self.user, 2026, 10)
        self.assertEqual(d["kpi"]["status"], "OVERSPENDING")
        self.assertEqual(d["banner"]["level"], "danger")
        self.assertEqual(d["kpi"]["net"], 6500)
        self.assertAlmostEqual(d["kpi"]["savings_rate"], 0.65)
        self.assertAlmostEqual(d["health"]["expected"], 1000)  # 3100 * 10/31
        self.assertEqual(d["health"]["cats_over"], 1)
        self.assertEqual(len(d["daily"]), 31)
        self.assertEqual(d["daily"][1]["status"], "OVER")
        self.assertEqual(d["top"][0]["item"], "Naivas")
        self.assertEqual(d["weeks"][0]["status"], "OVER")

    def test_year_view(self):
        Budget.objects.create(user=self.user, category=self.food, period="Monthly", amount=1000)
        Transaction.objects.create(user=self.user, date=date(2026, 3, 5), item="x", category=self.food, amount=500)
        y = services.year_view(self.user, 2026)
        self.assertEqual(y["months"][2]["spent"], 500)
        self.assertEqual(y["total"]["budget"], 12000)


class ApiTests(Base):
    def test_transaction_crud_and_revision(self):
        rev0 = services.get_profile(self.user).revision
        code, data = self.j("post", "/api/transactions", {
            "date": "2026-10-26", "time": "1:15 PM", "item": "Lunch at Java House",
            "category": self.out.id, "amount": "1,450", "payment_method": "",
        })
        self.assertEqual(code, 200, data)
        tx = data["item"]
        self.assertEqual((tx["time"], tx["amount"], tx["category"]), ("13:15", 1450.0, "Eating Out"))
        self.assertGreater(data["revision"], rev0)

        code, data = self.j("patch", f"/api/transactions/{tx['id']}", {"amount": "1500"})
        self.assertEqual(data["item"]["amount"], 1500)

        code, data = self.j("get", "/api/transactions?q=java&from=2026-10-01&to=2026-10-31")
        self.assertEqual((data["count"], data["total"]), (1, 1500))
        code, data = self.j("get", "/api/transactions?time_from=18:00&time_to=23:00")
        self.assertEqual(data["count"], 0)

        code, data = self.j("delete", f"/api/transactions/{tx['id']}")
        self.assertFalse(Transaction.objects.exists())

    def test_validation_errors_name_the_field(self):
        code, data = self.j("post", "/api/transactions", {"item": "x", "amount": "-5"})
        self.assertEqual((code, data["field"]), (400, "amount"))
        code, data = self.j("post", "/api/budgets", {"category": self.food.id, "amount": 10, "starts": "2026-10-10", "ends": "2026-10-01"})
        self.assertEqual(data["field"], "ends")

    def test_users_cannot_see_each_other(self):
        other = User.objects.create_user("bob", password="pw-12345-xyz")
        services.seed_defaults(other)
        t = Transaction.objects.create(user=other, date=date.today(), item="secret", amount=5)
        code, _ = self.j("get", f"/api/transactions/{t.id}")
        self.assertEqual(code, 404)
        code, data = self.j("post", "/api/transactions", {"item": "x", "amount": 5, "category": Category.objects.filter(user=other).first().id})
        self.assertEqual((code, data["field"]), (400, "category"))
        self.assertEqual(self.j("get", "/api/transactions")[1]["count"], 0)

    def test_suggest_remembers_last_details(self):
        Transaction.objects.create(user=self.user, date=date.today(), item="Uber to town", amount=450, category=self.out)
        _, data = self.j("get", "/api/suggest?q=ub")
        self.assertEqual(data["results"][0]["category_id"], self.out.id)

    def test_recurring_auto_posts_when_due(self):
        Recurring.objects.create(user=self.user, name="Rent", amount=25000, category=self.food,
                                 next_date=services.today() - timedelta(days=40), frequency="monthly")
        _, data = self.j("get", "/api/bootstrap")
        self.assertEqual(data["recurring_posted"], 2)
        self.assertEqual(Transaction.objects.filter(item="Rent").count(), 2)
        self.assertGreater(Recurring.objects.get().next_date, services.today())

    def test_goal_contribution_can_log_spending(self):
        _, g = self.j("post", "/api/goals", {"name": "Emergency", "target": 1000})
        _, g = self.j("post", f"/api/goals/{g['item']['id']}/contribute", {"amount": "250", "log_transaction": True})
        self.assertEqual(g["item"]["saved"], 250)
        self.assertTrue(Transaction.objects.filter(item="Savings: Emergency").exists())

    def test_lists_and_settings(self):
        code, data = self.j("post", "/api/lists/categories", {"name": "Pets", "icon": "🐶"})
        self.assertIn("Pets", [c["name"] for c in data["lists"]["categories"]])
        code, data = self.j("post", "/api/lists/categories", {"name": "Pets"})
        self.assertEqual(code, 400)
        _, data = self.j("patch", "/api/settings", {"warn_pct": 75})
        self.assertEqual(data["lists"]["warn_pct"], 0.75)

    def test_sync_and_pages(self):
        self.assertIn("revision", self.j("get", "/api/sync")[1])
        self.assertEqual(self.client.get("/").status_code, 200)
        self.client.logout()
        self.assertEqual(self.client.get("/api/sync").status_code, 302)


class ImportExportTests(Base):
    def test_import_blank_workbook(self):
        data = (HERE / "Money_Tracker_Blank.xlsx").read_bytes()
        resp = self.client.post("/api/import", {"file": SimpleUploadedFile("Money_Tracker_Blank.xlsx", data)})
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(Category.objects.filter(user=self.user).count(), 16)

    def test_round_trip_backup(self):
        Transaction.objects.create(user=self.user, date=date(2026, 10, 26), item="Lunch", amount=1450, category=self.out)
        Income.objects.create(user=self.user, date=date(2026, 10, 1), amount=50000)
        Budget.objects.create(user=self.user, category=self.food, period="Weekly", amount=3000)
        xlsx = self.client.get("/export/backup.xlsx").content
        wb = openpyxl.load_workbook(io.BytesIO(xlsx))
        self.assertEqual(wb["Transactions"]["C5"].value, "Lunch")

        other = User.objects.create_user("copy", password="pw-12345-xyz")
        self.client.force_login(other)
        resp = self.client.post("/api/import", {"file": SimpleUploadedFile("b.xlsx", xlsx)})
        s = resp.json()["summary"]
        self.assertEqual((s["transactions"], s["income"], s["budgets"]), (1, 1, 1))
        self.assertEqual(Transaction.objects.get(user=other).category.name, "Eating Out")

    def test_csv_import_and_export(self):
        csv_data = b"Date,Time,Item / Product,Category,Amount,Paid With\n2026-10-02,08:30,Matatu,Transport & Fuel,100,Cash\n,,bad,,,\n"
        resp = self.client.post("/api/import", {"file": SimpleUploadedFile("t.csv", csv_data), "kind": "transactions"})
        self.assertEqual(resp.json()["summary"], {"transactions": 1, "skipped": 1})
        out = self.client.get("/export/transactions.csv?q=matatu").content.decode()
        self.assertIn("Matatu", out)
