"""Serve compatibility snapshots and the React SPA shell for page routes."""

from fastapi.responses import HTMLResponse

from portal_backend.application import app
from portal_backend.container_snapshot_routes import get_container
from portal_backend.static_pages import serve_page


@app.get("/api/snapshot/{cid}")
def snapshot(cid: str):
    return get_container(cid)


# Every page route serves the same built SPA shell (static/dist/index.html);
# BrowserRouter owns which page renders, so the classic clean URLs
# (/tasks?task=..., /agents?agent=...) keep working unchanged
# (docs/orcha-portal-react-migration-plan.md Phase 7).


@app.get("/", response_class=HTMLResponse)
def home():
    return serve_page("dist/index.html")


@app.get("/settings", response_class=HTMLResponse)
def settings_page():
    return serve_page("dist/index.html")


@app.get("/agents", response_class=HTMLResponse)
def agents_page():
    return serve_page("dist/index.html")


@app.get("/requests", response_class=HTMLResponse)
def requests_page():
    return serve_page("dist/index.html")


@app.get("/tasks", response_class=HTMLResponse)
def tasks_page():
    return serve_page("dist/index.html")
