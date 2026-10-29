# 💰 Money Tracker (Django)

A personal finance tracker built from the **Money Tracker** Excel workbook: Income, Budgets,
Daily Spending and Insights. Amounts are in KES by default, and you can change the currency in Settings.

The whole app is a single page. Adding, editing, deleting, filtering and opening details all happen
in place, with no page reloads. Changes also sync live across every open tab and device.

## Quick start

```bash
pip install -r requirements.txt
python manage.py migrate
python manage.py demo            # optional: user "demo" / "demo12345" with 3 months of sample data
python manage.py runserver
```

Open http://127.0.0.1:8000, then sign in or create an account. Each account has its own private data.

## What's inside (mapped from the workbook)

| Workbook sheet | In the app |
|---|---|
| Dashboard | **Dashboard**: 6 KPI cards, an overspending/pace alert banner, spending health (pace, projection, safe-to-spend per day), daily spend vs allowance chart, budget vs actual by category, weekly breakdown, income by source, spending by payment method, and the top 5 expenses |
| Transactions + Search | **Transactions**: live search as you type, date range, category, payment method, time-of-day window (wraps past midnight) and min/max amount filters, sortable columns, infinite scroll, bulk delete, CSV export of what you see |
| Income | **Income**: filters, a by-source chart, and totals |
| Budget | **Budget**: Daily/Weekly/Monthly lines with optional Starts/Ends dates. They are set once and repeat every month, the same rule as the workbook. Lines are edited inline and per day/week/month amounts update as you type |
| Year View | **Year View**: a month-by-month chart and table, plus a category × month heatmap |
| Settings | **Settings**: categories (icon, colour, rename, reorder, hide), payment methods, income sources, currency, warning level (default 80%) and theme |

### Extras

- ⚡ **Quick add** (press `N` or `I`): autocomplete remembers each item's usual category, payment method and amount. Use *Save & add another* (`Shift+Enter`) to enter several in a row.
- 🗂 **Detail drawers**: click any transaction, category, day (in the chart or calendar) or week to see its details. Edits there save automatically.
- ↩️ **Undo** for every delete and every add.
- 🏆 **Savings goals**: progress rings, the amount you need to save each month to hit a deadline, and an option to log contributions as spending.
- 🔁 **Recurring bills and income**: these post automatically on their due date, or work as reminders with a *Record now* button.
- 📅 **Spending calendar heatmap** and **insights**: change vs last month, no-spend days, peak spending hour, busiest weekday, most frequent purchase.
- 📥 **Import your filled-in workbook (.xlsx)** or a CSV. 📤 Export a full .xlsx backup in the same sheet layout, which can be imported again, or export CSVs.
- 🌙 Dark mode, a mobile layout with a bottom nav, and keyboard shortcuts (press `?`).

## How "real time" works

- All data moves through a small JSON API (`tracker/api.py`). The UI (`tracker/static/tracker/app.js`)
  re-renders only what changed.
- Every write increases a per-user *revision* number. Other tabs in the same browser get notified at once
  through `BroadcastChannel`. Other devices check `/api/sync` every 5 seconds, and also whenever the tab
  regains focus, then refresh themselves.

## Project layout

```
config/            Django settings & URLs
tracker/models.py  Category, PaymentMethod, IncomeSource, Transaction, Income, Budget, Goal, Recurring, Profile
tracker/services.py  Dashboard / Year View maths (ported from the workbook formulas)
tracker/api.py     JSON API
tracker/dataio.py  .xlsx / .csv import & export
tracker/templates  App shell + login/signup
tracker/static     app.js, app.css, vendored Chart.js (works offline)
tracker/tests      Test suite (python manage.py test tracker)
```

## Production notes

Set `DJANGO_SECRET_KEY`, `DJANGO_DEBUG=0` and `DJANGO_ALLOWED_HOSTS`. Then run `python manage.py collectstatic`
and serve the app with gunicorn or a similar server.
