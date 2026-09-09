"""The production image's YouTube extraction prerequisites (#177).

Two halves that are only useful together: `yt-dlp-ejs` ships the JavaScript that
solves YouTube's signature and `n` challenges, and deno is what executes it.
Either one alone does nothing — yt-dlp reports the runtime as unavailable and
falls back to `android_vr`, which a datacenter IP answers with `LOGIN_REQUIRED`.

That failure is silent in the worst way: extraction still "works" for a while,
just at a 1-in-14 success rate, and the error it produces ("Sign in to confirm
you're not a bot") points at cookies rather than at the missing runtime. It cost
a measurement session to find. So the pairing is pinned here rather than left to
a comment.

Reading the files is the only way to test this without building the image, and
these are the sort of lines a later change removes as apparently dead weight.
"""

from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent
DOCKERFILE = BACKEND / "Dockerfile"
PYPROJECT = BACKEND / "pyproject.toml"


@pytest.fixture(scope="module")
def prod_stage() -> str:
    """Just the `prod` target — `dev` deliberately has none of this (#161)."""
    text = DOCKERFILE.read_text()
    _, _, after = text.partition("FROM base AS prod")
    assert after, "the Dockerfile no longer has a `prod` stage"
    return after


def test_prod_installs_a_javascript_runtime(prod_stage: str) -> None:
    assert "deno" in prod_stage, (
        "The prod image needs a JS runtime or YouTube extraction falls back to "
        "`android_vr` and a datacenter IP fails the bot check (#177)."
    )


def test_the_runtime_is_pinned(prod_stage: str) -> None:
    # A floating tag would let the runtime change under a rebuild that was meant
    # to change nothing — and this is the layer whose failure mode is a quiet
    # drop in success rate rather than an error.
    assert "denoland/deno:bin-" in prod_stage
    assert "denoland/deno:bin-latest" not in prod_stage
    assert ":latest" not in prod_stage.split("deno")[0][-60:]


def test_the_solver_scripts_ship_with_the_runtime() -> None:
    assert "yt-dlp-ejs" in PYPROJECT.read_text(), (
        "deno without `yt-dlp-ejs` has no challenge solver to run, so the "
        "runtime is present and still unusable."
    )


def test_the_cookie_mount_is_writable() -> None:
    """yt-dlp calls `cookiejar.save()` on close whenever `cookiefile` is set,
    so a `:ro` mount makes every extraction throw at the end (#177).

    Writing the rotated cookies back is also what keeps the session alive, so
    this is wanted rather than tolerated. `:ro` reads as the safer choice, which
    is exactly why it needs pinning — it was the original version, and the
    failure it caused looked like an ordinary bot check.
    """
    compose = (BACKEND.parent / "docker-compose.prod.yml").read_text()
    mounts = [
        line for line in compose.splitlines() if "secrets/cookies.txt" in line and "-" in line
    ]

    assert mounts, "the cookie mount is gone"
    for mount in mounts:
        assert not mount.rstrip().endswith(":ro"), mount


def test_the_dev_image_gets_neither() -> None:
    # Not an oversight: a home connection is not flagged, so a local install has
    # nothing to prove, and the plugin would reach for a provider that is not
    # running (#161). Pinned so "make dev match prod" does not quietly undo it.
    dev_stage = (
        DOCKERFILE.read_text().partition("FROM base AS dev")[2].partition("FROM base AS prod")[0]
    )
    assert "deno" not in dev_stage
    assert "--group pot" not in dev_stage
