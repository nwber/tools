"""Unit tests for the health payload builder (src/healthx.py)."""

from healthx import health_payload


def test_payload_shape():
    payload = health_payload(colo="MIA", now_utc="2026-10-13T00:00:00+00:00")
    assert payload == {
        "status": "ok",
        "service": "tools",
        "phase": 0,
        "version": "0.1.0",
        "colo": "MIA",
        "time_utc": "2026-10-13T00:00:00+00:00",
    }


def test_colo_omitted_when_absent():
    payload = health_payload(now_utc="2026-10-13T00:00:00+00:00")
    assert payload["colo"] is None
    assert payload["status"] == "ok"


def test_empty_colo_string_treated_as_absent():
    payload = health_payload(colo="")
    assert payload["colo"] is None
