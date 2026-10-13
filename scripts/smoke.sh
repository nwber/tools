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
CURL="curl -fsS --retry 5 --retry-delay 3 --retry-all-errors --max-time 30"