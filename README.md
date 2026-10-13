# tools

Developer tools served from a single Cloudflare Python Worker at
**https://tools.nbergeron.dev** — static assets for the UI, plain Python
(`WorkerEntrypoint`, no framework) for dynamic endpoints. See
[TODO.md](TODO.md) for the phased plan.

## Layout

```
src/entry.py         Worker entry point + routes (only module touching the Workers SDK)
src/ebs_pricing.py   EBS pricing calc (pure, unit-tested; Phase 0 synthetic data)
src/ipx.py           /ip helpers (pure)
src/healthx.py       /api/health payload (pure)
public/              static assets served without invoking the Worker (zero CPU)
tests/               pytest unit tests for the pure modules
scripts/smoke.sh     post-deploy smoke checks (local dev or production URL)
```

## Endpoints (Phase 0)

| Route | What it does |
| --- | --- |
| `GET /ip` | client IP as plain text (Cloudflare's `CF-Connecting-IP`, trailing newline) |
| `GET /ip.json` | same + `ip_version` and Cloudflare geo (`country`, `city`, `region`, `colo`, `asn`, `as_organization`, `timezone`) |
| `GET /api/health` | `{"status": "ok", ...}` with version, phase, edge colo, UTC time |
| `GET \| POST /api/ebs/calc` | EBS pricing calc across all volume types x regions |

`/api/ebs/calc` parameters: `size_gb` (1–16384, default 100), `iops`,
`throughput_mbps`, `repeat` (1–200), `regions` (comma-separated subset). The
response is the full pricing matrix plus `compute_ms` (server-side compute
wall time). `repeat` re-runs the whole matrix to scale CPU deliberately for
the spike.

> The pricing data here is a **synthetic representative snapshot** whose job
> is the CPU measurement — exact prices land in Phase 1
> (`public/data/ebs-pricing.json`).

### CPU decision rule (the point of the spike)

Free plan enforces a 10 ms CPU budget per request; tripping it returns
[error 1102](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1102/)
and shows up as `exceededCpu` in invocation analytics.

- Local reference (Python 3.14 / workerd): one full matrix pass
  (204 line items) ≈ 1.4 ms wall — `?repeat=200` took ~285 ms locally.
- Production check: hit `/api/ebs/calc` with growing `repeat` values while
  watching the Worker's dashboard metrics (Errors → Invocation Statuses) or
  `uv run pywrangler tail --format json` for `outcome: exceededCpu`.
- If the realistic single-pass calc ever trips `exceededCpu`, that tool's
  math moves client-side and Python keeps only I/O + light routes.

## Local development

```sh
uv sync --locked        # python env (uv 0.12.3+ and node required by pywrangler)
npm install             # wrangler, pinned in package.json (also serves the config schema)
uv run pywrangler dev   # serves http://127.0.0.1:8787, hot-reloads src/
uv run pytest           # unit tests (pure modules; no Workers runtime needed)
scripts/smoke.sh        # endpoint checks against the running dev server
uv run ruff check src tests && uv run ruff format --check src tests
```

Note: outside Cloudflare there is no edge-set `CF-Connecting-IP`; in local dev
`/ip` falls back to `X-Forwarded-For`, then to `unknown`.

## Deploy

CI deploys on every push to `main`: tests → `uv run pywrangler deploy` →
smoke checks against the custom domain
([.github/workflows/deploy.yml](.github/workflows/deploy.yml)).

Manual deploy (first time or local):

```sh
export CLOUDFLARE_API_TOKEN=...   # token scopes below
export CLOUDFLARE_ACCOUNT_ID=...  # from the dashboard (right side of the Workers page)
uv run pywrangler deploy
```

API token scopes (create at https://dash.cloudflare.com/profile/api-tokens):

| Scope | Why |
| --- | --- |
| Account > Workers Scripts > Edit | upload the Worker |
| Account > Account Settings > Read | resolve the account |
| Zone > Workers Routes > Edit | attach the `tools.nbergeron.dev` custom domain (scope to the nbergeron.dev zone) |

For CI, store both values as repository secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`:

```sh
gh secret set CLOUDFLARE_API_TOKEN   # paste token
gh secret set CLOUDFLARE_ACCOUNT_ID  # paste account id
```

## Conventions

- Work happens in git worktrees on `phase-N` branches; finished work merges
  to `main` (which auto-deploys).
- A gitleaks pre-commit hook blocks commits containing secrets
  (`git config core.hooksPath .githooks` after cloning; requires gitleaks on
  PATH).
- Compatibility date tracks "today" deliberately: it selects the runtime's
  Python version (2026-10-13 → Python 3.14). Bump it consciously.
