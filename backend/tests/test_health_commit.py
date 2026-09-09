"""`/health` publishes the commit the image was built from (#731).

⛔ **"Deployed" is not "live", and it has cost real time five times here** — a
droplet fourteen commits behind for four days, a Caddy image serving a page
twelve days old, and a deploy that omitted `-f docker-compose.prod.yml`, built
the *dev* project beside production and looked entirely successful. Every one was
found by fetching an artefact and looking; none by trusting an exit code.

So the running stack says what it is, and `droplet-drift.yml` compares that with
`main` over plain HTTPS — no deploy key, no CI access to production.

⚠️ **The field is only useful if it is honest about not knowing.** An image built
without the `MIO_GIT_SHA` build arg reports `unknown`, and the drift check treats
that as drift rather than as "fine" — because it means the deploy ran a command
that is not the documented one, which is the same class of mistake as the wrong
compose file.
"""

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    # `get_settings` is `@lru_cache`d and read at import time, so an env change
    # is invisible without this — the same reason editing `.env` needs a restart.
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_health_reports_the_commit_it_was_built_from(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GIT_SHA", "1234567890abcdef1234567890abcdef12345678")
    # ⚠️ After the env change, not before: the `client` fixture builds the app,
    # which reads `get_settings()` and repopulates the cache. Clearing only in a
    # fixture leaves this test asserting against the value it replaced.
    get_settings.cache_clear()

    body = client.get("/health").json()

    assert body["commit"] == "1234567890abcdef1234567890abcdef12345678"


def test_health_says_unknown_rather_than_omitting_the_field(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An unbuilt-with-the-arg image must still answer the question.

    A missing key would make the drift check's `.get("commit", ...)` fall back
    silently, which is the shape that turns a broken deploy into a green report.
    """
    monkeypatch.delenv("GIT_SHA", raising=False)
    get_settings.cache_clear()

    body = client.get("/health").json()

    assert body["commit"] == "unknown"


def test_health_keeps_the_string_deploy_stack_greps_for(client: TestClient) -> None:
    """⚠️ `deploy-stack.yml` matches the literal `"status":"ok"` in the raw body.

    That check is unrelated to this field, so adding one must not break it. This
    asserts on the serialised text rather than on the parsed dict, because the
    grep sees text.

    ⚠️ **It does not protect the key *order*, and an earlier version of this
    docblock claimed it did.** Mutation-tested: putting `commit` first still
    serialises `"status":"ok"` contiguously, so the grep survives and so does
    this test. That mutant is equivalent — the ordering genuinely does not
    matter — which is why no test was added to chase it.
    """
    response = client.get("/health")

    assert response.status_code == 200
    assert '"status":"ok"' in response.text
