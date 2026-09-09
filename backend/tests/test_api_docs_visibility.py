"""`/docs` is off on the public instance and on everywhere else (#765).

⛔ **`/api/docs`, `/api/redoc` and `/api/openapi.json` all answered 200 on the
live site**, through a public launch, publishing every endpoint, parameter and
schema to anyone who asked. Nothing was exposed that a request could not already
reach, but a public instance has no reader who needs the interactive browser, and
it is free reconnaissance.

⚠️ **Mutation-tested, and one mutant survives on purpose.** Making `docs_url`
unconditional changes nothing observable, because FastAPI only mounts `/docs` and
`/redoc` when `openapi_url` is also set — so `openapi_url` alone closes all
three. That mutant is *equivalent* while the code stands as it is. The other two
conditions are kept rather than deleted because they stop being redundant the
moment anyone makes `openapi_url` unconditional, which the mutation run
confirmed: with `openapi_url` forced on, `/docs` and `/redoc` stayed shut.

⚠️ **The default stays True.** Most of what makes this backend approachable to a
self-hoster is being able to open `/docs` and press buttons. Only the production
compose file turns it off, which is why the last test here reads that file: a
setting nothing sets protects nothing (#655's shape — both halves passing is not
the join passing).
"""

import importlib
import logging
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient

from app.config import Settings, get_settings

# ⚠️ Relative to this file, not to the working directory: pytest runs from
# `backend/` and the compose file is a level up, so a bare filename passes
# locally only by accident of where it was invoked.
COMPOSE = Path(__file__).resolve().parents[2] / "docker-compose.prod.yml"


@pytest.fixture
def rebuilt_app(monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[[], TestClient]]:
    """Rebuild the real app under the current environment, then put it back.

    ⚠️ **Reloading `app.main` re-runs `configure_logging()`, which *replaces*
    the root logger's handlers** — including the one pytest's `caplog` installs.
    Left alone that would break unrelated tests depending on file order, which is
    the alembic `fileConfig` trap this repo has already paid for once. So the
    handlers are snapshotted and restored.
    """
    import app.main

    root = logging.getLogger()
    saved_handlers, saved_level = root.handlers[:], root.level

    def build() -> TestClient:
        get_settings.cache_clear()
        return TestClient(importlib.reload(app.main).app)

    try:
        yield build
    finally:
        monkeypatch.undo()
        get_settings.cache_clear()
        importlib.reload(app.main)
        root.handlers, root.level = saved_handlers, saved_level
        get_settings.cache_clear()


@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_documentation_is_served_by_default(
    rebuilt_app: Callable[[], TestClient], path: str
) -> None:
    """The control. Without it, "off" is indistinguishable from a route that
    never existed, and every assertion below would pass against a deleted app."""
    with rebuilt_app() as client:
        assert client.get(path).status_code == 200


@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_documentation_is_gone_when_disabled(
    rebuilt_app: Callable[[], TestClient], monkeypatch: pytest.MonkeyPatch, path: str
) -> None:
    """404, because the route is not built at all.

    ⚠️ Asserting 404 rather than "not 200": a handler that returned 403 or 401
    would still confirm the path is special, and the point is that there is
    nothing there.
    """
    monkeypatch.setenv("API_DOCS_ENABLED", "false")

    with rebuilt_app() as client:
        assert client.get(path).status_code == 404


def test_the_rest_of_the_api_is_unaffected_when_documentation_is_off(
    rebuilt_app: Callable[[], TestClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Turning the browser off must not turn the API off."""
    monkeypatch.setenv("API_DOCS_ENABLED", "false")

    with rebuilt_app() as client:
        assert client.get("/health").json()["status"] == "ok"


def test_the_setting_defaults_to_on(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("API_DOCS_ENABLED", raising=False)
    get_settings.cache_clear()

    assert Settings().api_docs_enabled is True


def test_production_compose_turns_it_off() -> None:
    """⛔ The half that actually protects the droplet.

    A setting exists in `config.py`; it is this file that decides what the public
    instance does with it. A test of the setting alone would pass against a
    production stack still serving `/docs` to the world.
    """
    assert COMPOSE.exists(), f"{COMPOSE} is missing — this test is pointed at nothing"
    compose = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))

    serving = [
        name
        for name, service in compose["services"].items()
        if "backend" in name or "worker" in name
    ]
    assert serving, "no backend service found — this test is pointed at the wrong file"

    for name in serving:
        environment = compose["services"][name].get("environment", {})
        assert environment.get("API_DOCS_ENABLED") == "false", (
            f"{name} does not disable the API documentation in production"
        )
