/**
 * toolbox.nbergeron.dev — the Worker resource.
 *
 * Declared as an Alchemy Runtime: the props describe the Worker to deploy,
 * the Effect is what it does. `main: import.meta.url` tells Alchemy to bundle
 * this file's default export as the script. The request logic itself lives in
 * `src/handler.ts` so it can be exercised in-process by vitest; this file adds
 * the speed-test rate limit in front of it.
 */

import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { fetchHandler } from "./handler.ts";

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
      runWorkerFirst: [
        "/api/*",
        "/ip",
        "/ip.json",
        "/speedtest/ping",
        "/speedtest/down",
        "/speedtest/up",
      ],
    },
    // toolbox.nbergeron.dev is canonical; ip.nbergeron.dev is the dedicated
    // curl-friendly host for the IP endpoints.
    domain: {
      name: "toolbox.nbergeron.dev",
      aliases: ["ip.nbergeron.dev"],
    },
  },
  Effect.gen(function* () {
    // Per-colo rate limit for the speed-test endpoints: generous enough for a
    // full test run (pings + parallel chunks), tight enough to stop hammering.
    const speedtestLimit = yield* Cloudflare.RateLimit("SPEEDTEST_LIMIT", {
      namespaceId: 46891,
      simple: { limit: 200, period: 60 },
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.originalUrl).pathname;
        if (path.startsWith("/speedtest/")) {
          const ip = (request.source as Request).headers.get("CF-Connecting-IP") ?? "unknown";
          const { success } = yield* speedtestLimit
            .limit({ key: `speedtest:${ip}` })
            .pipe(Effect.orElseSucceed(() => ({ success: true })));
          if (!success) {
            return yield* HttpServerResponse.json(
              { error: "rate limited — wait a minute and retry" },
              { status: 429, headers: { "cache-control": "no-store" } },
            );
          }
        }
        return yield* fetchHandler;
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Workers.RateLimitBinding)),
);
