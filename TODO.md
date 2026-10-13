Architecture

Revision (2026-10-14): the runtime language decision changed — the whole
project is now TypeScript. Effect 4 for the Worker runtime, Alchemy v2
("Infrastructure as Effects") for IaC; Python/pywrangler/uv/pytest dropped in
favor of vitest. Phase 0 additionally validates the Alchemy deploy path
(state store bootstrap, domains). The Python-flavored text below is the
original plan and still useful as history; where it conflicts with the
revision, the revision wins.

Phase 0 — COMPLETE (2026-10-13)

- Delivered: Effect 4 Worker + Alchemy v2 IaC in nwber/tools; live at
  tools.nbergeron.dev (canonical) and ip.nbergeron.dev, with /ip, /ip.json,
  /api/health, and GET|POST /api/ebs/calc (6 volume types x 34 regions).
- CI: typecheck + 40 vitest tests on PRs (unit + in-process handler tests via
  HttpServerRequest.fromWeb); credential preflight; deploy on main via
  alchemy + real post-deploy smoke checks.
- CPU question resolved by construction: the runtime is TypeScript (no
  Pyodide), so the free plan's 10 ms/request budget is a non-issue; the EBS
  calc runs server-side in well under 1 ms (see compute_ms in responses).

Phase 1 — COMPLETE (2026-10-14)

- The original EBS tool's source existed only as its live deployment
  (ebs-pricing-comparator.nwber.workers.dev); it was recovered from there
  and ported faithfully to /ebs/ (calc stays client-side).
- Pricing tables extracted verbatim to public/data/ebs-pricing.json; the
  same JSON is also served at GET /api/ebs/pricing (the phase-0 synthetic
  /api/ebs/calc endpoint was removed with its module/tests).
- Parity proven in a real browser vs the original: identical rendered
  tables in default / modified-input / limit-warning scenarios, and
  md5-identical screenshots (local and live).
- 29 vitest tests incl. the ported math against the real dataset; smoke.sh
  now covers /ebs/, /data/ebs-pricing.json, and /api/ebs/pricing.
- The old workers.dev deployment is still live; decommission it whenever
  the custom-domain copy is confirmed as the one to keep.

Phase 2 — COMPLETE (2026-10-14)

- Scope revised per request: only t3a, t4g, t8i; each size tier compared
  against the cheapest non-burstable instance with the same physical
  processor and vCPU count (exact memory twin when one exists, else the
  closest size, flagged in the UI).
- Generated dataset (scripts/generate-burst-spec.mjs -> committed
  public/data/ec2-burst-spec.json): 18 sizes, 14 regions where every
  compared type is priced, on-demand + RI + Savings-Plan terms both sides;
  credit tables from AWS docs, unlimited surcharges from the AWS pricing
  page. Data gap surfaced: t8i has no RI pricing yet (falls back with a
  visible note).
- /ec2/: client-side simulation (credit accrual/spend, standard-mode
  depletion + throttling, unlimited surcharges, break-even average CPU,
  RI/SP toggle both sides), inline SVG credit chart, comparison table;
  model documented in ec2-burst-calc.js and covered by hand-computed tests.
- GET /api/ec2/burst-spec + smoke checks + index link. 42 tests total.
- Follow-up hardening: smoke.sh now waits for the deployed WORKER_VERSION
  to be live before checking (the first phase-2 deploy hit a POP still
  serving the previous script version).

Phase 3 — COMPLETE (2026-10-14)

- /speedtest/ live: GET /speedtest/ping, GET /speedtest/down?bytes=N
  (random bytes streamed, 1 KiB-100 MiB per request), POST /speedtest/up
  (streaming drain, 16 MiB per-request cap, echoes bytes + ms).
- Per-IP rate limiting in code via Cloudflare's Rate Limiting binding
  (200 req/min per colo, fail-open); sizes capped server-side.
- UI: latency + jitter (15 pings, warm-up discarded), 6 parallel download
  streams + 4 parallel chunked uploads over ~10 s windows, live Mbps,
  colo/IP display. Measurement math unit-tested.
- Live run from this network: edge BOS, 187 Mbps down / 66.6 Mbps up,
  latency 31.7-41.6 ms, jitter 8.8 ms. Smoke checks cover the endpoints.

Phase 4 — S3 cost calculator — COMPLETE (2026-10-14)

- /s3/ live: storage classes (incl. the five Intelligent-Tiering access
  tiers + monitoring fee), per-class request pricing, retrieval with
  standard/bulk/expedited modes, lifecycle transitions, minimum-duration
  warnings; notes for unmodeled fees (restore requests, early delete).
- Dataset generated from the public AWS Price List API offers
  (scripts/generate-s3-pricing.mjs -> public/data/s3-pricing.json,
  34 regions; Deep Archive from its separate offer; overloaded
  usagetypes disambiguated by the operation attribute).
- GET /api/s3/pricing for API use; browser-verified math.

Phase 4 — AWS region latency — COMPLETE (2026-10-14)

- /aws-latency/ live: browser-measured HTTPS RTT to all 34 commercial AWS
  regions against the regional DynamoDB health URL
  (https://dynamodb.<region>.amazonaws.com/ answers 200 with a tiny text
  body, no redirect; the s3/ec2/sts root endpoints 30x to aws.amazon.com).
- Scope revision: the original item asked for availability zones, but AWS
  publishes no public per-AZ HTTPS endpoints — zone-pinned endpoints exist
  only for resources you create (RDS instances, NLBs, ...). The tool
  therefore measures regions, which is what the plan's fallback clause
  called for.
- Dataset from botocore's endpoints.json (scripts/generate-aws-regions.mjs
  -> public/data/aws-regions.json: codes, display names, geography groups,
  source sha256 recorded); also served at GET /api/aws/regions.
- UI: group filters (US & Canada + Europe pre-selected), sample-major probe
  schedule with a concurrency cap, first probe per region discarded as
  DNS/TCP/TLS warm-up, opaque no-cors fetches timed with performance.now(),
  rows ranked by median when the run finishes (or is stopped).

Remaining in phase 4: data transfer estimator, CIDR/subnet planner.

One Python Worker: static assets (HTML/CSS/JS/JSON) + Python endpoints for dynamic behavior + speed test streaming.
Free-plan-aware layout: pricing datasets and UI logic are static/zero-CPU where possible; Python WorkerEntrypoint (plain, not FastAPI) as default to keep CPU and startup minimal — FastAPI only if the Phase 0 spike shows comfortable headroom.
No KV at launch; pricing tables are JSON assets refreshed by a scheduled GitHub Action (regenerates + commits + deploys). This avoids runtime cron entirely, which matters since free-plan cron CPU is also 10ms.
Custom domain tools.nbergeron.dev via wrangler; DNS is automatic since the zone is already on your Cloudflare account.
Phase 0 — spike (validates the risky assumptions)

New repo, pywrangler/uv scaffold, wrangler config, custom domain, GitHub Actions deploy with CLOUDFLARE_API_TOKEN (you create the token, I'll document scopes).
/ip (canhazip clone: CF-Connecting-IP as text, /ip.json variant) + /api/health.
One realistic compute endpoint (pricing calc over all EBS types/regions) to measure CPU under the 10ms budget. Decision rule: if it trips exceededCpu, that tool's math moves client-side (like your current EBS tool) and Python keeps only I/O + light routes.
Phase 1 — index + EBS port

Port your exact source: pricing tables → public/data/ebs-pricing.json, HTML/CSS/JS → public/ebs/, calc stays client-side (faithful port), plus /api/ebs/pricing serving the same JSON for API use. Note: your hardcoded prices are a snapshot; adding an AWS Price List refresh script later is optional and diffs visibly in git.
Phase 2 — EC2 burst calculator

Generated static spec table (T2/T3/T3a/T4g: baselines, credit rates/balances, prices, unlimited surcharge) from AWS docs/pricing via a scripts/ generator committed to the repo.
Inputs: family/size, region, avg+peak CPU%, hours/day, days, standard vs unlimited.
Outputs: credit balance timeline + time-to-depletion, throttle time (standard), effective cost (unlimited), breakeven vs equivalent m-family, RI/Savings Plan toggle, recommendation. Client-side chart.
Phase 3 — speed test

GET /speedtest/down?bytes=N (streams a pre-generated buffer — cheap), POST /speedtest/up (bounded ~5–10MB chunks, streaming drain), GET /speedtest/ping. JS UI: latency/jitter, 4–6 parallel streams, Mbps, colo/IP display.
Risk: per-chunk Python FFI/CPU on upload drain under 10ms. Fallback if it's a problem: serve the speed endpoints from a small JS module/worker at the same route. Size caps + Cloudflare rate limiting rule to prevent abuse.
Phase 4 — extras

S3 cost calculator (storage classes, request pricing, lifecycle), data transfer estimator (egress/NAT vs VPC endpoints), CIDR/subnet planner (pure client-side math from your VPC CIDR).
AZ latency tool: measure ping latency to AWS availability zones (from the browser, so HTTPS/TCP RTT; use per-AZ public endpoints where they exist — e.g. service endpoints pinned per AZ — and fall back to regional endpoints + AZ-local services where not). Show a per-AZ latency table, likely Europe/US first since that's what gets used from here.
Workflow & verification

Git worktree per your AGENTS.md, commits per phase, final on main. No ansible changes (wrangler owns deployment/DNS); I'll flag if anything turns out to need a homelab-side change.
Tests: pytest for pricing/burst/CIDR logic; pywrangler dev integration checks; post-deploy smoke tests in CI; wrangler tail/analytics for CPU verification in Phase 0.
Open items for kickoff: repo owner/name confirmation, and whether you'd also like ip.nbergeron.dev as a dedicated hostname for curl ergonomics (optional, one line in wrangler).
