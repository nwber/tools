/**
 * tools.nbergeron.dev — the Worker resource.
 *
 * Declared as an Alchemy Runtime: the props describe the Worker to deploy,
 * the Effect is what it does. `main: import.meta.url` tells Alchemy to bundle
 * this file's default export as the script. The request logic itself lives in
 * `src/handler.ts` so it can be exercised in-process by vitest.
 */

import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

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
      fetch: fetchHandler,
    };
  }),
);
