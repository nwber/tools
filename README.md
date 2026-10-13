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

See [TODO.md](TODO.md) for the phased plan (its Python-Worker opening chapter
was superseded by the 2026-10-14 revision note).

## Layout

```
alchemy.run.ts          Stack: providers + state + Worker (the composition root)
src/worker.ts           Worker resource: props + speed-test rate limit
src/handler.ts          request handler (in-process testable)
src/tools/ip.ts         /ip helpers (pure, vitest-tested)
src/tools/speedtest.ts  speed-test parameter parsing + caps (pure)
public/index.html       tools index (static)
public/ebs/             the EBS pricing calculator page (ported, see Phase notes)
public/ec2/             the EC2 burst calculator page (Phase 2)
public/s3/              the S3 cost calculator page (Phase 4)
public/aws-latency/     the AWS region latency page (Phase 4)
public/speedtest/       the speed test page (Phase 3)
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

- Work happens in git worktrees on `phase-N` branches; finished work merges to
  `main` (which auto-deploys).
- A gitleaks pre-commit hook blocks commits containing secrets
  (`git config core.hooksPath .githooks` after cloning; requires gitleaks on
  PATH).
- The Worker pins its runtime behavior with `compatibility: { date }` in
  `src/worker.ts`; bump it consciously (currently 2026-10-13 — Cloudflare
  validates the date against UTC and rejects "future" dates).

## Phase notes

Phase 0 originally spiked Cloudflare **Python** Workers against the free
plan's 10 ms CPU budget. The runtime was then moved to TypeScript/Effect —
one language for runtime, tests, and IaC — which removes the Pyodide CPU
question entirely.

Phase 1 ported the EBS pricing calculator. The original source only existed
as its live deployment (`ebs-pricing-comparator.nwber.workers.dev`), so it
was recovered from there and ported faithfully:

- the pricing tables became `public/data/ebs-pricing.json` (the dataset the
  page loads, also served at `GET /api/ebs/pricing`);
- the page became `public/ebs/` with the math split into `ebs-calc.js`
  (vitest-tested against the real dataset) and the DOM wiring in `ebs-page.js`;
- behavior parity with the original was verified in a real browser
  (identical rendered tables and byte-identical screenshots across default,
  modified-input, and limit-warning scenarios).

The Phase 3 speed-test fallback story (serve speed endpoints without a heavy
runtime) is unaffected.

Phase 2 added the EC2 burst calculator (`/ec2/`), scoped to **t3a, t4g, and
t8i**:

- the dataset (`public/data/ec2-burst-spec.json`) is generated by
  `scripts/generate-burst-spec.mjs` from the Vantage ec2instances.info price
  dump plus the AWS docs' credit tables (both cited in the script), and is
  committed so refreshes diff visibly;
- for every burstable size, the comparison is the **cheapest non-burstable
  instance with the same physical processor and vCPU count** — an exact
  memory twin where one exists (m5a for t3a, c6g/m6g for t4g, c8i-flex for
  t8i), otherwise the closest available size (flagged in the UI). The tiny T
  ratios (2 vCPU with 0.5–2 GiB) have no non-burstable equivalent at all;
- the simulation (CPU-credit accrual/spend, standard-mode throttling, time to
  depletion, unlimited-mode surcharges, break-even average CPU, RI/Savings
  Plan pricing) lives in `public/ec2/ec2-burst-calc.js` and is unit-tested
  against the committed dataset;
- t8i has no Reserved Instance pricing in the source yet, so RI terms fall
  back to on-demand with a visible note.

Phase 3 added the speed test (`/speedtest/`): latency + jitter via
`/speedtest/ping`, download through parallel streams of `/speedtest/down`
(random bytes, 1 KiB–100 MiB per request), and upload through parallel
chunked POSTs to `/speedtest/up` (16 MiB per-request cap, streaming drain).
The endpoints are per-IP rate limited in code via Cloudflare's Rate Limiting
binding (200 requests/minute, per colo), and the page shows the client's
colo/IP and measured Mbps. Measurement math is unit-tested.

The S3 cost calculator (`/s3/`) covers storage classes (including the five
Intelligent-Tiering access tiers and its monitoring fee), request pricing,
retrieval fees (standard/bulk/expedited where offered — including the
currently-free Glacier Flexible bulk retrieval), lifecycle transitions, and
minimum-storage-duration warnings. Prices are generated from the public AWS
Price List API offers (`scripts/generate-s3-pricing.mjs` →
`public/data/s3-pricing.json`, 34 regions) with the overloaded usagetypes
disambiguated by the products' `operation` attribute.

The AWS region latency tool (`/aws-latency/`) measures HTTPS round-trip time
from the visitor's browser to the public endpoint of every commercial AWS
region. The probe target is the regional DynamoDB health URL
(`https://dynamodb.<region>.amazonaws.com/`), which answers unauthenticated
GETs with a tiny text body and no redirect — the s3/ec2/sts root endpoints
30x to aws.amazon.com marketing pages, which a browser fetch would follow at
the cost of a second round trip. The region list
(`public/data/aws-regions.json`, generated by
`scripts/generate-aws-regions.mjs` from botocore's endpoints file and also
served at `GET /api/aws/regions`) carries display names and geography
groups. The page discards the first probe per region as DNS/TCP/TLS warm-up,
times opaque `no-cors` fetches with `performance.now()`, and ranks rows by
median when the run finishes. This replaces the original per-AZ plan: AWS
publishes no public per-AZ HTTPS endpoints (zone-pinned endpoints exist only
for resources you create, like RDS instances or NLBs), so region reach is
the honest granularity from a browser.
