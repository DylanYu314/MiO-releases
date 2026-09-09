"""Unit tests for the adaptive download pacer (Enhancement Track B0)."""

import pytest

from app.pacing import AdaptivePacer


def make_pacer(**overrides: float) -> AdaptivePacer:
    defaults = dict(delay=4.0, minimum=1.0, maximum=30.0, shrink=0.5, grow=2.0, enabled=True)
    defaults.update(overrides)
    return AdaptivePacer(**defaults)  # type: ignore[arg-type]


def test_shrinks_on_success_down_to_the_minimum() -> None:
    pacer = make_pacer(delay=4.0, minimum=1.0, shrink=0.5)
    pacer.on_success()
    assert pacer.delay == 2.0
    pacer.on_success()
    assert pacer.delay == 1.0
    pacer.on_success()  # already at the floor
    assert pacer.delay == 1.0


def test_grows_on_transient_failure_up_to_the_maximum() -> None:
    pacer = make_pacer(delay=4.0, maximum=10.0, grow=2.0)
    pacer.on_transient_failure()
    assert pacer.delay == 8.0
    pacer.on_transient_failure()  # capped at the ceiling
    assert pacer.delay == 10.0


def test_wait_sleeps_the_current_delay(monkeypatch: pytest.MonkeyPatch) -> None:
    slept: list[float] = []
    monkeypatch.setattr("app.pacing.time.sleep", slept.append)

    pacer = make_pacer(delay=3.0, minimum=1.0, shrink=0.5)
    pacer.wait()
    pacer.on_success()
    pacer.wait()

    assert slept == [3.0, 1.5]


def test_disabled_pacer_never_sleeps_or_adjusts(monkeypatch: pytest.MonkeyPatch) -> None:
    slept: list[float] = []
    monkeypatch.setattr("app.pacing.time.sleep", slept.append)

    pacer = make_pacer(delay=0.0, enabled=False)
    pacer.on_success()
    pacer.on_transient_failure()
    pacer.wait()

    assert pacer.delay == 0.0
    assert slept == []


def test_from_settings_disables_when_pacing_is_zero() -> None:
    # conftest sets DOWNLOAD_PACING_SECONDS=0, so the suite's pacer is off.
    assert AdaptivePacer.from_settings().enabled is False


def test_from_settings_maps_every_knob(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeSettings:
        download_pacing_seconds = 5.0
        download_pacing_min_seconds = 2.0
        download_pacing_max_seconds = 40.0
        download_pacing_shrink = 0.7
        download_pacing_grow = 3.0

    monkeypatch.setattr("app.pacing.get_settings", FakeSettings)

    pacer = AdaptivePacer.from_settings()
    assert (pacer.delay, pacer.minimum, pacer.maximum, pacer.shrink, pacer.grow, pacer.enabled) == (
        5.0,
        2.0,
        40.0,
        0.7,
        3.0,
        True,
    )
