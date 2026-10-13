"""Cloudflare Python Worker entry point for tools.nbergeron.dev (Phase 0 spike).

Plain WorkerEntrypoint routing (no FastAPI) to keep CPU and startup minimal —
the plan's default. Static pages under public/ are served by the Workers
static-assets layer without invoking this Worker at all; only the routes
listed in `run_worker_first` reach this code.

This is the only module allowed to import the `workers` SDK / `js` FFI —
everything else stays pure so pytest can exercise it locally.
"""

import traceback
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qs, urlsplit

from js import Date
from workers import Response, WorkerEntrypoint

import ebs_pricing
import healthx
import ipx

_VERSION = healthx.WORKER_VERSION

_BASE_HEADERS = {"cache-control": "no-store", "access-control-allow-origin": "*"}


def _headers(content_type: str) -> dict[str, str]:
    return {**_BASE_HEADERS, "content-type": content_type}


def _json(data: Any, status: int = 200) -> Response:
    return Response.json(data, status=status, headers=_headers("application/json"))


def _text(body: str, status: int = 200) -> Response:
    return Response(body, status=status, headers=_headers("text/plain; charset=utf-8"))


def _lower_headers(request: Any) -> dict[str, str]:
    return {str(key).lower(): str(value) for key, value in request.headers.items()}


def _cf_dict(request: Any) -> dict:
    try:
        cf = request.cf
    except Exception:
        return {}
    if cf is None:
        return {}
    try:
        return cf.to_py()
    except Exception:
        return {}


def _query_dict(url: str) -> dict[str, str]:
    return {key: values[0] for key, values in parse_qs(urlsplit(url).query).items() if values}


async def _handle_ip_text(request: Any) -> Response:
    ip = ipx.client_ip_from_headers(_lower_headers(request))
    return _text(ip + "\n")


async def _handle_ip_json(request: Any) -> Response:
    ip = ipx.client_ip_from_headers(_lower_headers(request))
    payload = {
        "ip": ip,
        "ip_version": ipx.ip_version(ip),
        **ipx.cf_summary(_cf_dict(request)),
    }
    return _json(payload)


async def _handle_health(request: Any) -> Response:
    payload = healthx.health_payload(
        version=_VERSION,
        colo=_cf_dict(request).get("colo"),
        now_utc=datetime.now(UTC).isoformat(timespec="seconds"),
    )
    return _json(payload)


def _ebs_response(inputs: ebs_pricing.EbsInputs) -> Response:
    started_ms = Date.now()
    result = ebs_pricing.compute_ebs_matrix(inputs)
    elapsed_ms = round(Date.now() - started_ms, 3)
    return _json(
        {
            "ok": True,
            "inputs": inputs.as_dict(),
            "line_items": result["line_items"],
            "iterations": inputs.repeat,
            "compute_ms": elapsed_ms,
            "totals": result["totals"],
            "matrix": result["matrix"],
            "note": "synthetic snapshot prices for the Phase 0 CPU spike; "
            "real pricing tables land in Phase 1",
        }
    )


async def _handle_ebs_calc_get(request: Any) -> Response:
    return _ebs_response(ebs_pricing.parse_ebs_inputs(_query_dict(request.url)))


async def _handle_ebs_calc_post(request: Any) -> Response:
    body = await request.json()
    if not isinstance(body, dict):
        raise ValueError("request body must be a JSON object")
    return _ebs_response(ebs_pricing.parse_ebs_inputs(body))


_ROUTES: dict[tuple[str, str], Any] = {
    ("GET", "/ip"): _handle_ip_text,
    ("GET", "/ip.json"): _handle_ip_json,
    ("GET", "/api/health"): _handle_health,
    ("GET", "/api/ebs/calc"): _handle_ebs_calc_get,
    ("POST", "/api/ebs/calc"): _handle_ebs_calc_post,
}


class Default(WorkerEntrypoint):
    async def fetch(self, request: Any) -> Response:
        path = urlsplit(request.url).path
        # HEAD rides along with GET (the runtime strips the body).
        method = str(request.method)
        lookup_method = "GET" if method == "HEAD" else method

        handler = _ROUTES.get((lookup_method, path))
        if handler is not None:
            try:
                return await handler(request)
            except ValueError as exc:
                return _json({"error": str(exc)}, status=400)
            except Exception:
                traceback.print_exc()
                return _json({"error": "internal server error"}, status=500)

        if any(route_path == path for _, route_path in _ROUTES):
            return _json({"error": "method not allowed", "method": method}, status=405)

        if path.startswith("/api/"):
            return _json({"error": "not found", "path": path}, status=404)

        # Unknown non-API paths fall back to static assets (public/404.html).
        try:
            return await self.env.ASSETS.fetch(request)
        except Exception:
            return _json({"error": "not found", "path": path}, status=404)
