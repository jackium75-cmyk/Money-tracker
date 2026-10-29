from django.contrib.auth import views as auth_views
from django.urls import path

from . import api, views

urlpatterns = [
    path("", views.app, name="app"),
    path("login/", auth_views.LoginView.as_view(), name="login"),
    path("logout/", auth_views.LogoutView.as_view(), name="logout"),
    path("signup/", views.signup, name="signup"),
    path("export/transactions.csv", views.export_transactions, name="export_transactions"),
    path("export/income.csv", views.export_income, name="export_income"),
    path("export/backup.xlsx", views.export_workbook, name="export_workbook"),
    # JSON API
    path("api/bootstrap", api.bootstrap),
    path("api/sync", api.sync),
    path("api/lists", api.lists),
    path("api/dashboard", api.dashboard),
    path("api/year", api.year_view),
    path("api/transactions", api.transactions),
    path("api/transactions/bulk-delete", api.transactions_bulk_delete),
    path("api/transactions/<int:pk>", api.transaction_detail),
    path("api/suggest", api.suggest),
    path("api/income", api.income),
    path("api/income/<int:pk>", api.income_detail),
    path("api/budgets", api.budgets),
    path("api/budgets/<int:pk>", api.budget_detail),
    path("api/goals", api.goals),
    path("api/goals/<int:pk>", api.goal_detail),
    path("api/goals/<int:pk>/contribute", api.goal_contribute),
    path("api/recurring", api.recurring),
    path("api/recurring/<int:pk>", api.recurring_detail),
    path("api/recurring/<int:pk>/post", api.recurring_post_now),
    path("api/lists/<str:kind>", api.list_create),
    path("api/lists/<str:kind>/reorder", api.list_reorder),
    path("api/lists/<str:kind>/<int:pk>", api.list_detail),
    path("api/settings", api.settings_update),
    path("api/import", api.import_file),
]
