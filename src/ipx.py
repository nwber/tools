"""Pure helpers for the /ip endpoints (no Workers SDK imports; unit-testable)."""

from collections.abc import Mapping

# Header fallback chain, most-trusted first. CF-Connecting-IP is set by the
# Cloudflare edge and cannot be spoofed from outside; the rest only matter in
# local dev (workerd doesn't set CF-Connecting-IP for plain curl requests).
_CLIENT_IP_HEADERS = ("cf-connecting-ip", "true-client-ip", "x-forwarded-for")

UNKNOWN_IP = "unknown"


def client_ip_from_headers(headers: Mapping[str, str]) -> str:
    """Return the best-effort client IP from request headers.

    Header names must already be lower-cased (the Worker entry point
    normalizes them).
    """
    for name in _CLIENT_IP_HEADERS:
        value = (headers.get(name) or "").strip()
        if name == "x-forwarded-for" and value:
            value = value.split(",")[0].strip()
        if value:
            return value
    return UNKNOWN_IP


def ip_version(ip: str) -> int | None:
    """Return 4 or 6 for a plausible IPv4/IPv6 address string, else None."""
    if ":" in ip:
        return 6
    if "." in ip:
        return 4
    return None


# (request.cf property name, output key) — the subset useful for debugging and
# for the future speed test UI (phase 3 shows the serving colo).
_CF_FIELDS: tuple[tuple[str, str], ...] = (
    ("country", "country"),
    ("city", "city"),
    ("region", "region"),
    ("colo", "colo"),
    ("asn", "asn"),
    ("asOrganization", "as_organization"),
    ("timezone", "timezone"),
)


def cf_summary(cf: Mapping[str, object] | None) -> dict:
    """Extract the useful Cloudflare request properties as a plain dict."""
    summary: dict[str, object | None] = {output: None for _, output in _CF_FIELDS}
    if not isinstance(cf, Mapping):
        return summary
    for source, output in _CF_FIELDS:
        value = cf.get(source)
        if value is None or value == "":
            continue
        if isinstance(value, (int, float, bool)):
            summary[output] = value
        else:
            summary[output] = str(value)
    return summary
