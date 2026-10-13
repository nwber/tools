#!/usr/bin/env bash
# Post-deploy smoke tests: verify the live endpoints answer as designed.
#
# Usage: scripts/smoke.sh [base-url]
#   base-url defaults to http://127.0.0.1:8787 (pywrangler dev).
#   IP_BASE=<url> optionally also checks the dedicated ip.* hostname.

set -euo pipefail

BASE="${1:-http://127.0.0.1:8787}"
IP_BASE="${IP_BASE:-}"
CURL="curl -fsS --retry 5 --retry-delay 3 --retry-all-errors --max-time 30"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

body=$($CURL "$BASE/") || fail "GET / failed"
grep -qi '<!doctype html' <<<"$body" || fail "GET / did not return an HTML page"

body=$($CURL "$BASE/ip") || fail "GET /ip failed"
[[ -n "$body" ]] || fail "GET /ip returned an empty body"
echo "ok: /ip -> $body"

body=$($CURL "$BASE/ip.json") || fail "GET /ip.json failed"
grep -q '"ip"' <<<"$body" || fail "GET /ip.json missing ip field: $body"

body=$($CURL "$BASE/api/health") || fail "GET /api/health failed"
grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' <<<"$body" || fail "health not ok: $body"

body=$($CURL "$BASE/api/ebs/calc?size_gb=100") || fail "GET /api/ebs/calc failed"
grep -q '"line_items"' <<<"$body" || fail "ebs calc missing line_items: $body"

status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/ebs/calc?size_gb=0") || fail "ebs calc request failed"
[[ "$status" == "400" ]] || fail "expected 400 for invalid size_gb, got $status"

status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/missing") || fail "missing-route request failed"
[[ "$status" == "404" ]] || fail "expected 404 for unknown api route, got $status"

if [[ -n "$IP_BASE" ]]; then
  body=$($CURL "$IP_BASE/ip") || fail "GET $IP_BASE/ip failed"
  [[ -n "$body" ]] || fail "$IP_BASE/ip returned an empty body"
  echo "ok: ip-host /ip -> $body"
fi

echo "all smoke checks passed for $BASE"
