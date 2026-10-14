# tools

One TypeScript codebase for **https://toolbox.nbergeron.dev** (and
**https://ip.nbergeron.dev**):

- **Runtime** — a Cloudflare Worker written as an [Effect 4](https://effect.website/docs/v4/onboarding)
  program (`src/worker.ts`).
- **Infrastructure** — [Alchemy v2](https://alchemy.run) ("Infrastructure as
  Effects"): the Worker, its static assets, and its custom domains are declared
  in `alchemy.run.ts`; `alchemy deploy` applies it.
- **Static pages** — `public/` is served by Cloudflare's asset layer without
  invoking the Worker at all (zero CPU); dynamic routes go through the Worker.

## Layout

```
alchemy.run.ts          Stack: providers + state + Worker (the composition root)
src/worker.ts           Worker resource: props + speed-test rate limit
src/handler.ts          request handler (in-process testable)
src/tools/ip.ts         /ip helpers (pure, vitest-tested)
src/tools/speedtest.ts  speed-test parameter parsing + caps (pure)
public/index.html       tools index (static)
public/ebs/             the EBS pricing calculator page (ported from the original tool)
public/ec2/             the EC2 burst calculator page
public/s3/              the S3 cost calculator page
public/aws-latency/     the AWS region latency page
public/ip-hex/          the IP ↔ hex converter page
public/speedtest/       the speed test page
public/data/            shared datasets (ebs-pricing.json, ec2-burst-spec.json, s3-pricing.json, aws-regions.json)
scripts/                committed generators (generate-burst-spec.mjs, generate-s3-pricing.mjs, generate-aws-regions.mjs)
tests/                  vitest tests (pure modules, handler, client math)
scripts/smoke.sh        post-deploy endpoint checks (deploy URL or local dev URL)
```

## Endpoints

| Route | What it does |
| --- | --- |
| `GET /ebs/` | the AWS EBS Pricing calculator (static page, client-side math) |
| `GET /ec2/` | the EC2 Burst Calculator (static page, client-side simulation) |
| `GET /s3/` | the S3 Cost Calculator (static page, client-side model) |
| `GET /aws-latency/` | the AWS Region Latency test (static page, browser-side measurement) |
| `GET /ip-hex/` | the IP ↔ hex converter (static page, client-side conversion) |
| `GET /speedtest/` | the speed test page (latency + parallel down/upload) |
| `GET /data/*.json` | the datasets the calculators load (static assets) |
| `GET /ip` | client IP as plain text (Cloudflare's `CF-Connecting-IP`, trailing newline) |
| `GET /ip.json` | same + `ip_version` and Cloudflare geo (`country`, `city`, `region`, `colo`, `asn`, `as_organization`, `timezone`) |
| `GET /api/health` | `{"status": "ok", ...}` with version, phase, edge colo, UTC time |
| `GET /api/ebs/pricing` | the EBS dataset for API use (bundled from `public/data/ebs-pricing.json`) |
| `GET /api/ec2/burst-spec` | the burst dataset for API use (bundled from `public/data/ec2-burst-spec.json`) |
| `GET /api/s3/pricing` | the S3 dataset for API use (bundled from `public/data/s3-pricing.json`) |
| `GET /api/aws/regions` | the AWS region list + probe metadata (bundled from `public/data/aws-regions.json`) |
| `GET /speedtest/ping` | tiny `pong` for latency measurement |
| `GET /speedtest/down?bytes=N` | streams N random bytes (1 KiB – 100 MiB per request) |
| `POST /speedtest/up` | drains the body, echoes `bytes_received` (16 MiB per-request cap) |

> The pricing data is a hardcoded snapshot ported from the original EBS tool
> (recovered from its `ebs-pricing-comparator.nwber.workers.dev` deployment).
> A refresh script against the AWS Price List API is optional and, when it
> lands, will diff visibly in git.

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

- Work happens in git worktrees on branches; finished work merges to `main`
  (which auto-deploys).
- PRs against `main` pass through a review gate: the `protect_main` ruleset
  requires one approving review and dismisses stale approvals on new pushes;
  the admin account is in the bypass list for emergencies only.
- A gitleaks pre-commit hook blocks commits containing secrets
  (`git config core.hooksPath .githooks` after cloning; requires gitleaks on
  PATH).
- The Worker pins its runtime behavior with `compatibility: { date }` in
  `src/worker.ts`; bump it consciously (currently 2026-10-13 — Cloudflare
  validates the date against UTC and rejects "future" dates).
- Pages stay phone-friendly: wide tables reflow into stacked cards and nothing
  scrolls horizontally (verified down to 320px).

## TODO

See [TODO.md](TODO.md) for the plan and history.

- Data transfer estimator — egress/NAT vs VPC endpoints
- CIDR/subnet planner — pure client-side math from your VPC CIDR
- Decommission the old `ebs-pricing-comparator.nwber.workers.dev` deployment
  (still live; superseded by `/ebs/`)
