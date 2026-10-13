#!/usr/bin/env bash
# Post-deploy smoke tests: verify the endpoints answer as designed.
#
# Usage: scripts/smoke.sh <base-url>
#   e.g. scripts/smoke.sh https://tools.nbergeron.dev
#        scripts/smoke.sh http://localhost:1337   # URL printed by `alchemy dev`
#   IP_BASE=<url> optionally also checks the dedicated ip.* hostname.

set -euo pipefail

if [[ $# -lt 1 || -z "${1:-}" ]]; then
  echo "usage: scripts/smoke.sh <base-url>" >&2
  exit 2
fi

BASE="$1"
IP_BASE="${IP_BASE:-}"
CHECKS=0
CURL="curl -fsS --retry 5 --retry-delay 3 --retry-all-errors --max-time 30"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

check() { CHECKS=$((CHECKS + 1)); }

body=$($CURL "$BASE/") || fail "GET / failed"; check
grep -qi '<!doctype html' <<<"$body" || fail "GET / did not return an HTML page"
grep -q 'AWS EBS Pricing' <<<"$body" || fail "index does not link the EBS tool"

body=$($CURL "$BASE/ebs/") || fail "GET /ebs/ failed"; check
grep -q '<title>AWS EBS Pricing</title>' <<<"$body" || fail "/ebs/ did not return the calculator page"

body=$($CURL "$BASE/data/ebs-pricing.json") || fail "GET /data/ebs-pricing.json failed"; check
grep -q '"volumeTypes"' <<<"$body" || fail "pricing asset missing volumeTypes"

body=$($CURL "$BASE/ip") || fail "GET /ip failed"; check
[[ -n "$body" ]] || fail "GET /ip returned an empty body"
echo "ok: /ip -> $body"

body=$($CURL "$BASE/ip.json") || fail "GET /ip.json failed"; check
grep -q '"ip"' <<<"$body" || fail "GET /ip.json missing ip field: $body"

body=$($CURL "$BASE/api/health") || fail "GET /api/health failed"; check
grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' <<<"$body" || fail "health not ok: $body"

body=$($CURL "$BASE/api/ebs/pricing") || fail "GET /api/ebs/pricing failed"; check
grep -q '"volumeTypes"' <<<"$body" || fail "/api/ebs/pricing missing volumeTypes"

status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/ebs/pricing") || fail "POST /api/ebs/pricing request failed"; check
[[ "$status" == "405" ]] || fail "expected 405 for POST /api/ebs/pricing, got $status"

status=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/missing") || fail "missing-route request failed"; check
[[ "$status" == "404" ]] || fail "expected 404 for unknown api route, got $status"

if [[ -n "$IP_BASE" ]]; then
  body=$($CURL "$IP_BASE/ip") || fail "GET $IP_BASE/ip failed"; check
  [[ -n "$body" ]] || fail "$IP_BASE/ip returned an empty body"
  echo "ok: ip-host /ip -> $body"
fi

[[ "$CHECKS" -ge 10 ]] || fail "only $CHECKS checks ran; expected at least 10"
echo "all $CHECKS smoke checks passed for $BASE"
