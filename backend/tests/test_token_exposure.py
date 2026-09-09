"""No response schema may carry an OAuth token (#687).

#687's sharpest line is that **a comment is not a mechanism**: `models.py` said
"revisit before any cloud deployment", the deployment happened on 2026-07-29,
and nothing noticed for over a month.

The decision on storage is recorded in `models.py` and is not what this file
tests. This tests the leak that would actually matter — a token reaching a
client through the API — because that is the one failure a self-hoster could not
detect and could not undo.

⚠️ **It walks every schema rather than naming endpoints.** The only guard that
existed before was one line in `test_spotify_api.py` asserting `access_token`
was absent from one Spotify response. It covered one field, one table, and one
endpoint — and `GoogleAccount` has the identical problem, which is exactly how
#687 came to name only half of its own subject.
"""

import inspect

from pydantic import BaseModel

from app import schemas

# Substrings rather than exact names: `spotify_refresh_token` and
# `token_secret` are the same mistake as `refresh_token` and should fail too.
FORBIDDEN = ("access_token", "refresh_token", "client_secret", "token_secret")

# ⚠️ Allowed because they are not credentials. `token_expires_at` is a
# timestamp, and leaking "this connection expires at 14:00" tells an attacker
# nothing they can use. Listed explicitly so that adding to it is a decision
# somebody makes on purpose rather than a regex quietly widening.
ALLOWED_EXACT = {"token_expires_at"}


def _response_models() -> list[type[BaseModel]]:
    return [
        obj
        for _, obj in inspect.getmembers(schemas, inspect.isclass)
        if issubclass(obj, BaseModel) and obj is not BaseModel
    ]


def test_the_guard_has_something_to_check() -> None:
    """Control.

    Without this, every assertion below passes vacuously against an empty list —
    a renamed module, a failed import, a changed export. A check that cannot
    fail has measured nothing, and this repo has paid for that four times.
    """
    models = _response_models()
    assert len(models) > 20, f"only found {len(models)} schemas; the walk is broken"


def test_no_schema_exposes_a_token() -> None:
    offenders: list[str] = []
    for model in _response_models():
        for field in model.model_fields:
            if field in ALLOWED_EXACT:
                continue
            if any(bad in field for bad in FORBIDDEN):
                offenders.append(f"{model.__name__}.{field}")

    assert not offenders, "response schemas expose OAuth credentials: " + ", ".join(offenders)


def test_the_account_schemas_still_carry_something() -> None:
    """Second control, aimed at the *scenario* rather than the code.

    `test_no_schema_exposes_a_token` also passes if the account schemas stop
    existing, or lose all their fields. Pinning that they still describe an
    account keeps the guard pointed at a live target.
    """
    assert "spotify_user_id" in schemas.SpotifyAccountRead.model_fields
    assert "display_name" in schemas.SpotifyAccountRead.model_fields
