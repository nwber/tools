/**
 * The Worker's request handler — routing and responses, as an Effect program.
 *
 * Kept separate from `worker.ts` (which declares the Alchemy resource) so the
 * handler can run in-process under vitest: tests provide `HttpServerRequest`
 * via `HttpServerRequest.fromWeb` and assert on real responses.
 *
 * Routes:
 *   GET  /ip               client IP as plain text
 *   GET  /ip.json          client IP + Cloudflare geo as JSON
 *   GET  /api/health       health check
 *   GET  /api/ebs/pricing  the shared EBS pricing dataset (same JSON asset
 *                          the calculator page loads from /data/)
 */

import * as Effect from "effect/Effect";
import type { HttpBodyError } from "effect/http/HttpBody";
import * as Headers from "effect/http/Headers";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";

import ebsPricing from "../public/data/ebs-pricing.json";
import { cfSummary, clientIpFromHeaders, ipVersion, type CfProperties } from "./tools/ip.ts";

export const WORKER_VERSION = "0.3.0";
export const PHASE = 1;

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

const cfProperties = (source: object | undefined): CfProperties | undefined =>
  (source as { readonly cf?: CfProperties } | undefined)?.cf;

export const fetchHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest;
  const method = request.method === "HEAD" ? "GET" : request.method;
  // `request.url` is the server-relative target (the runtime strips scheme
  // and host); `originalUrl` is the absolute URL as received.
  const url = new URL(request.originalUrl);
  const header = (name: string) => Option.getOrUndefined(Headers.get(request.headers, name));
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

    case "GET /api/ebs/pricing":
      // The dataset is versioned by the deploy; a short public cache is fine.
      return yield* HttpServerResponse.json(ebsPricing, {
        headers: { ...BASE_HEADERS, "cache-control": "public, max-age=300" },
      });
  }

  if (url.pathname === "/api/ebs/pricing" || url.pathname === "/api/health") {
    return yield* json({ error: "method not allowed", method: request.method }, 405);
  }
  if (url.pathname.startsWith("/api/")) {
    return yield* json({ error: "not found", path: url.pathname }, 404);
  }
  // Unknown non-API paths: no static asset matched, so answer 404 here.
  return html(NOT_FOUND_HTML, 404);
});
