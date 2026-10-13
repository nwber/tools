"""Pure payload builders for the /api/health endpoint (unit-testable)."""

SERVICE_NAME = "tools"
PHASE = 0
WORKER_VERSION = "0.1.0"


def health_payload(
    *,
    version: str = WORKER_VERSION,
    colo: object | None = None,
    now_utc: str | None = None,
) -> dict:
    payload: dict[str, object] = {
        "status": "ok",
        "service": SERVICE_NAME,
        "phase": PHASE,
        "version": version,
        "colo": None,
    }
    if colo not in (None, ""):
        payload["colo"] = str(colo)
    if now_utc is not None:
        payload["time_utc"] = now_utc
    return payload
