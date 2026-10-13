/**
 * Infrastructure as code for tools.nbergeron.dev.
 *
 * One Effect 4 program (via Alchemy v2 "Infrastructure as Effects"). This
 * file is the composition root: it wires the Cloudflare provider plus the
 * state store and yields the Worker declared in src/worker.ts — which
 * carries both its deployment props and its runtime implementation.
 *
 * Commands (from the repo root):
 *   npx alchemy dev                 # local workerd + hot reload
 *   npx alchemy plan --stage prod   # diff against production, no changes
 *   npx alchemy deploy --stage prod # apply (CI does this on push to main)
 *
 * Auth: locally via `npx alchemy profile create`; in CI via the
 * CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID repository secrets.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import Worker from "./src/worker.ts";

export default Alchemy.Stack(
  "tools",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Worker;

    return {
      url: worker.url.as<string>(),
      urls: worker.urls,
      scriptName: worker.workerName,
    };
  }),
);
