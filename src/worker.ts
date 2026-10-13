/**
 * tools.nbergeron.dev — the Worker runtime.
 *
 * Declared as an Alchemy Runtime: the props describe the Worker to deploy,
 * the Effect is what it does. `main: import.meta.url` tells Alchemy to bundle
 * this file's default export as the script.
 *
 * Routes:
 *   GET  /ip            client IP as plain text
 *   GET  /ip.json       client IP + Cloudflare geo as JSON
 *   GET  /api/health    health check
 *   GET  /api/ebs/calc  EBS pricing matrix (all volume types x regions)
 *   POST /api/ebs/calc  same, JSON body
 */

import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import type { HttpBodyError } from "effect/http/HttpBody";
import * as Headers from "effect/http/Headers";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";

import { cfSummary, clientIpFromHeaders, ipVersion, type CfProperties } from "./tools/ip.ts";
import { computeEbsMatrix, parseEbsInputs } from "./tools/ebs-pricing.ts";

export const WORKER_VERSION = "0.2.0";
export const PHASE = 0;

type ResponseEffect = Effect.Effect<HttpServerResponse.HttpServerResponse, HttpBodyError>;

const BASE_HEADERS = {
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
} as const;

const json = (body: unknown, status = 200): ResponseEffect =>
  HttpServerResponse.json(body, { status, headers: BASE_HEADERS });

const text = (body: string, status = 200) =>
  HttpServerResponse.text(body, {
    status,
    contentType: "text/plain; charset=utf-8",
    headers: BASE_HEADERS,
  });

const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>404 — tools.nbergeron.dev</title></head>
  <body style="font-family: ui-monospace, monospace; background: #0b1220; color: #d6e2f0">
    <h1>404</h1>
    <p>no such tool (yet) — back to <a style="color: #7fb4ff" href="/">tools.nbergeron.dev</a></p>
  </body>
</html>
`;

const html = (body: string, status = 200) =>
  HttpServerResponse.text(body, {
    status,
    contentType: "text/html; charset=utf-8",
    headers: { "cache-control": "no-store" },
  });

const cfProperties = (source: object): CfProperties | undefined =>
  (source as { readonly cf?: CfProperties }).cf;

export default Cloudflare.Worker(
  "Worker",
  {
    main: import.meta.url,
    // A deliberate pin to a current runtime behavior set (rustles in new
    // defaults like nodejs_compat <= 2026-08-04). Bump consciously, never to
    // a date Cloudflare considers "the future" (it validates against UTC).
    compatibility: { date: "2026-10-13" },
    // Static pages are served by Cloudflare's asset layer without invoking
    // the Worker; the dynamic routes below always go through it.
    assets: {
      directory: "./public",
      runWorkerFirst: ["/api/*", "/ip", "/ip.json"],
    },
    // tools.nbergeron.dev is canonical; ip.nbergeron.dev is the dedicated
    // curl-friendly host for the IP endpoints.
    domain: {
      name: "tools.nbergeron.dev",
      aliases: ["ip.nbergeron.dev"],
    },
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const method = request.method === "HEAD" ? "GET" : request.method;
        const url = new URL(request.url);
        const header = (name: string) =>
          Option.getOrUndefined(Headers.get(request.headers, name));
        const cf = cfProperties(request.source);

        switch (`${method} ${url.pathname}`) {
          case "GET /ip":
            return text(clientIpFromHeaders(header) + "\n");

          case "GET /ip.json": {
            const ip = clientIpFromHeaders(header);
            return yield* json({ ip, ip_version: ipVersion(ip), ...cfSummary(cf) });
          }

          case "GET /api/health":
            return yield* json({
              status: "ok",
              service: "tools",
              phase: PHASE,
              version: WORKER_VERSION,
              colo: cf?.colo ?? null,
              time_utc: new Date().toISOString(),
            });

          case "GET /api/ebs/calc":
            return yield* ebsCalcResponse(Object.fromEntries(url.searchParams));

          case "POST /api/ebs/calc": {
            const body = yield* Effect.option(request.json);
            if (
              Option.isNone(body) ||
              typeof body.value !== "object" ||
              body.value === null ||
              Array.isArray(body.value)
            ) {
              return yield* json({ error: "request body must be a JSON object" }, 400);
            }
            return yield* ebsCalcResponse(body.value as Record<string, unknown>);
          }
        }

        if (url.pathname === "/api/ebs/calc") {
          return yield* json({ error: "method not allowed", method: request.method }, 405);
        }
        if (url.pathname.startsWith("/api/")) {
          return yield* json({ error: "not found", path: url.pathname }, 404);
        }
        // Unknown non-API paths: no static asset matched, so answer 404 here.
        return html(NOT_FOUND_HTML, 404);
      }),
    };
  }),
);

function ebsCalcResponse(values: Record<string, unknown>): ResponseEffect {
  const parsed = parseEbsInputs(values);
  if (!parsed.ok) {
    return json({ error: parsed.error }, 400);
  }
  const { inputs } = parsed;
  const startedAt = performance.now();
  const result = computeEbsMatrix(inputs);
  const computeMs = Math.round((performance.now() - startedAt) * 1000) / 1000;
  return json({
    ok: true,
    inputs: {
      size_gb: inputs.sizeGb,
      iops: inputs.iops ?? null,
      throughput_mbps: inputs.throughputMbps ?? null,
      regions: [...inputs.regions],
    },
    line_items: result.lineItems,
    compute_ms: computeMs,
    totals: result.totals,
    matrix: result.matrix,
    note: "representative snapshot prices; the real dataset lands with the Phase 1 EBS port",
  });
}
