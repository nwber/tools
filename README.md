# tools

One TypeScript codebase for **https://tools.nbergeron.dev** (and
**https://ip.nbergeron.dev**):

- **Runtime** — a Cloudflare Worker written as an [Effect 4](https://effect.website/docs/v4/onboarding)
  program (`src/worker.ts`).
- **Infrastructure** — [Alchemy v2](https://alchemy.run) ("Infrastructure as
  Effects"): the Worker, its static assets, and its custom domains are declared
  in `alchemy.run.ts`; `alchemy deploy` applies it.
- **Static pages** — `public/` is served by Cloudflare's asset layer without
  invoking the Worker at all (zero CPU); dynamic routes go through the Worker.

See [TODO.md](TODO.md) for the phased plan (its Python-Worker opening chapter
was superseded by the 2026-10-14 revision note).

## Layout

```
alchemy.run.ts          Stack: providers + state + Worker (the composition root)
src/worker.ts           Worker runtime: routing + responses (Effect 4)
src/tools/ip.ts         /ip helpers (pure, vitest-tested)
src/tools/ebs-pricing.ts EBS pricing calc (pure, vitest-tested)
public/                 static assets (index.html), served without a Worker invocation
tests/                  vitest unit tests for the pure modules
scripts/smoke.sh        post-deploy endpoint checks (deploy URL or local dev URL)
```

## Endpoints

| Route | What it does |
| --- | --- |
| `GET /ip` | client IP as plain text (Cloudflare's `CF-Connecting-IP`, trailing newline) |
| `GET /ip.json` | same + `ip_version` and Cloudflare geo (`country`, `city`, `region`, `colo`, `asn`, `as_organization`, `timezone`) |
| `GET /api/health` | `{"status": "ok", ...}` with version, phase, edge colo, UTC time |
| `GET \| POST /api/ebs/calc` | EBS pricing matrix across all volume types × regions |

`/api/ebs/calc` parameters: `size_gb` (1–16384, default 100), `iops`,
`throughput_mbps`, `regions` (comma-separated subset, or a list in a JSON
body). The response is the full matrix plus `compute_ms` (server-side compute
time).

> The pricing data is a **representative snapshot** (realistic shapes, not
> verified AWS quotes) — the real dataset refreshed from the AWS Price List
> API lands with the Phase 1 EBS port.

## Local development

Requirements: Node 24+ (Effect 4 and Alchemy targets). No Python/uv anymore.

```sh
npm install
npx alchemy profile create   # one-time Cloudflare credentials (OAuth or API token)
npm run dev                  # workerd + hot reload; prints its local URL
npm test                     # vitest unit tests (pure modules only)
npm run typecheck            # tsc --noEmit across alchemy.run.ts, src/, tests/
npm run check                # typecheck + tests

scripts/smoke.sh <url>       # e.g. the http://localhost:... URL `alchemy dev` prints
```

`alchemy dev` runs the Worker locally in workerd with hot reload. It still
resolves Cloudflare credentials (even though nothing is created in the cloud
for this stack), so the profile must exist.

## Infrastructure & deploy

```sh
npx alchemy plan   --stage prod   # dry-run diff
npx alchemy deploy --stage prod   # apply (this is what CI runs on main)
npx alchemy destroy --stage prod  # tear everything down
```

On the first deploy, Alchemy bootstraps its **state store** in the account:
an `alchemy-state-store` Worker plus a Secrets Store entry holding its bearer
token. Subsequent deploys diff against that state.

CI ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)) runs tests,
deploys `prod` on every push to main, then smoke-tests both domains.

Repository secrets needed for CI:

| Secret | Contents |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token (scopes below) |
| `CLOUDFLARE_ACCOUNT_ID` | account ID from the Cloudflare dashboard |

API token scopes (create at https://dash.cloudflare.com/profile/api-tokens):

| Scope | Why |
| --- | --- |
| Account > Workers Scripts > Edit | upload the Worker (and the state-store Worker) |
| Account > Secrets Store > Edit | the state store's bearer token |
| Account > Account Settings > Read | resolve the account |
| Zone > Workers Routes > Edit | attach the custom domains (scope to the nbergeron.dev zone) |
| Zone > DNS > Edit | DNS records for the custom domains |

```sh
gh secret set CLOUDFLARE_API_TOKEN   --repo nwber/tools
gh secret set CLOUDFLARE_ACCOUNT_ID  --repo nwber/tools
```

> First deploy on an account where the hostnames were previously attached to a
> wrangler-managed Worker: delete that old Worker first — a hostname can only
> attach to one Worker.

## Conventions

- Work happens in git worktrees on `phase-N` branches; finished work merges to
  `main` (which auto-deploys).
- A gitleaks pre-commit hook blocks commits containing secrets
  (`git config core.hooksPath .githooks` after cloning; requires gitleaks on
  PATH).
- The Worker pins its runtime behavior with `compatibility: { date }` in
  `src/worker.ts`; bump it consciously (currently 2026-10-14).

## Phase notes

Phase 0 originally spiked Cloudflare **Python** Workers against the free
plan's 10 ms CPU budget. The runtime was then moved to TypeScript/Effect —
one language for runtime, tests, and IaC — which removes the Pyodide CPU
question entirely. The EBS pricing endpoint and the health/IP endpoints carry
over unchanged in shape; the Phase 3 speed-test fallback story (serve speed
endpoints without a heavy runtime) is unaffected.
