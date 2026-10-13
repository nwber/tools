/**
 * Pure S3 cost model (unit-tested with vitest; DOM wiring in s3-page.js).
 *
 * Costs modeled per storage class:
 *   - storage, with the tiered rates for S3 Standard / Intelligent-Tiering
 *     Frequent Access (51200 GB, then 512000 GB cumulative boundaries);
 *   - PUT/COPY/POST/LIST and GET/HEAD/other requests at class-specific rates;
 *   - lifecycle transitions into the class at the class's transition rate;
 *   - retrieval (when the class charges for it) at standard/bulk/expedited
 *     rates where the price list exposes them;
 *   - the Intelligent-Tiering monitoring & automation fee per 1,000 objects.
 *
 * Not modeled (surfaced as notes instead): restore *request* fees, early
 * deletion fees (they depend on object lifetimes), small-object fees, and
 * data transfer.
 */

/** Storage rows in display order; `classId` selects the request/transition prices. */
export const STORAGE_ROWS = [
  { key: "standard", classId: "standard", label: "Standard" },
  { key: "it-frequent", classId: "intelligent-tiering", label: "IT — Frequent Access" },
  { key: "it-infrequent", classId: "intelligent-tiering", label: "IT — Infrequent Access" },
  { key: "it-archive-instant", classId: "intelligent-tiering", label: "IT — Archive Instant Access" },
  { key: "it-archive", classId: "intelligent-tiering", label: "IT — Archive Access" },
  { key: "it-deep-archive", classId: "intelligent-tiering", label: "IT — Deep Archive Access" },
  { key: "standard-ia", classId: "standard-ia", label: "Standard-IA" },
  { key: "onezone-ia", classId: "onezone-ia", label: "One Zone-IA" },
  { key: "glacier-ir", classId: "glacier-ir", label: "Glacier Instant Retrieval" },
  { key: "glacier-flexible", classId: "glacier-flexible", label: "Glacier Flexible Retrieval" },
  { key: "glacier-deep-archive", classId: "glacier-deep-archive", label: "Glacier Deep Archive" },
];

/** Classes that charge retrieval fees, with the modes the price list exposes. */
export const RETRIEVAL_CLASSES = [
  { classId: "standard-ia", modes: ["standard"] },
  { classId: "onezone-ia", modes: ["standard"] },
  { classId: "glacier-ir", modes: ["standard"] },
  { classId: "glacier-flexible", modes: ["standard", "bulk", "expedited"] },
  { classId: "glacier-deep-archive", modes: ["standard", "bulk"] },
];

const round = (value, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** Tiered storage cost for `gb` against [{upToGb, perGbMonth}] tiers. */
export function tieredStorageCost(gb, tiers) {
  let remaining = Math.max(0, gb);
  let cost = 0;
  let from = 0;
  for (const tier of tiers) {
    if (remaining <= 0) break;
    const capacity = tier.upToGb === null ? Infinity : Math.max(0, tier.upToGb - from);
    const used = Math.min(remaining, capacity);
    cost += used * tier.perGbMonth;
    remaining -= used;
    if (tier.upToGb !== null) from = tier.upToGb;
  }
  return cost;
}

function storageRateFor(key, classPrices) {
  const stripes = {
    standard: classPrices["standard"].storageTiers,
    "it-frequent": classPrices["intelligent-tiering"].tiers.frequent.storageTiers,
    "it-infrequent": classPrices["intelligent-tiering"].tiers.infrequent.storageTiers,
    "it-archive-instant": classPrices["intelligent-tiering"].tiers["archive-instant"].storageTiers,
    "it-archive": classPrices["intelligent-tiering"].tiers.archive.storageTiers,
    "it-deep-archive": classPrices["intelligent-tiering"].tiers["deep-archive"].storageTiers,
    "standard-ia": classPrices["standard-ia"].storageTiers,
    "onezone-ia": classPrices["onezone-ia"].storageTiers,
    "glacier-ir": classPrices["glacier-ir"].storageTiers,
    "glacier-flexible": classPrices["glacier-flexible"].storageTiers,
    "glacier-deep-archive": classPrices["glacier-deep-archive"].storageTiers,
  };
  return stripes[key];
}

function retrievalRate(classId, mode, classPrices) {
  const prices = classPrices[classId];
  if (mode === "bulk") return prices.retrievalBulkPerGb ?? prices.retrievalPerGb;
  if (mode === "expedited") return prices.retrievalExpeditedPerGb ?? prices.retrievalPerGb;
  return prices.retrievalPerGb ?? 0;
}

/**
 * @param {object} pricingDoc - public/data/s3-pricing.json
 * @param {object} inputs
 * @param {string} inputs.region
 * @param {Record<string, number>} inputs.storageGb - keyed by STORAGE_ROWS key
 * @param {Record<string, {put?: number, get?: number}>} inputs.requests - per class, per month
 * @param {number} inputs.itObjectsPerMonth - objects in Intelligent-Tiering
 * @param {Record<string, {gb: number, mode?: string}>} inputs.retrieval - per class, per month
 * @param {Record<string, number>} inputs.transitions - into each class, per month
 */
export function computeS3Cost(pricingDoc, inputs) {
  const notes = [];
  const region = pricingDoc.regions.find((r) => r.id === inputs.region);
  if (!region) return { ok: false, error: `unknown region ${inputs.region}` };
  const prices = pricingDoc.prices[region.id];

  const storageLines = [];
  let storageTotal = 0;
  for (const row of STORAGE_ROWS) {
    const gb = Math.max(0, Number(inputs.storageGb?.[row.key] ?? 0) || 0);
    if (gb === 0) continue;
    const tiers = storageRateFor(row.key, prices);
    const cost = tieredStorageCost(gb, tiers);
    storageTotal += cost;
    storageLines.push({ key: row.key, label: row.label, gb, cost: round(cost) });
  }

  const requestLines = [];
  let requestsTotal = 0;
  for (const classId of Object.keys(inputs.requests ?? {})) {
    const classPrices = prices[classId];
    if (!classPrices) return { ok: false, error: `unknown class ${classId}` };
    const put = Math.max(0, Number(inputs.requests[classId]?.put ?? 0) || 0);
    const get = Math.max(0, Number(inputs.requests[classId]?.get ?? 0) || 0);
    if (put === 0 && get === 0) continue;
    const putCost = (put / 1000) * (classPrices.putPer1000 ?? 0);
    const getCost = (get / 1000) * (classPrices.getPer1000 ?? 0);
    requestsTotal += putCost + getCost;
    requestLines.push({
      classId,
      put,
      get,
      putCost: round(putCost),
      getCost: round(getCost),
      cost: round(putCost + getCost),
    });
  }

  const retrievalLines = [];
  let retrievalTotal = 0;
  for (const entry of RETRIEVAL_CLASSES) {
    const request = inputs.retrieval?.[entry.classId];
    if (!request) continue;
    const gb = Math.max(0, Number(request.gb ?? 0) || 0);
    if (gb === 0) continue;
    const mode = entry.modes.includes(request.mode) ? request.mode : entry.modes[0];
    const rate = retrievalRate(entry.classId, mode, prices);
    const cost = gb * rate;
    retrievalTotal += cost;
    retrievalLines.push({ classId: entry.classId, gb, mode, ratePerGb: round(rate, 4), cost: round(cost) });
  }

  const transitionLines = [];
  let transitionsTotal = 0;
  for (const [classId, countRaw] of Object.entries(inputs.transitions ?? {})) {
    const classPrices = prices[classId];
    if (!classPrices) return { ok: false, error: `unknown class ${classId}` };
    const count = Math.max(0, Number(countRaw ?? 0) || 0);
    if (count === 0) continue;
    const cost = (count / 1000) * (classPrices.transitionInPer1000 ?? 0);
    transitionsTotal += cost;
    transitionLines.push({
      classId,
      count,
      ratePer1000: round(classPrices.transitionInPer1000 ?? 0, 4),
      cost: round(cost),
    });
  }

  const itObjects = Math.max(0, Number(inputs.itObjectsPerMonth ?? 0) || 0);
  const monitoringCost =
    (itObjects / 1000) * (prices["intelligent-tiering"].monitoringPer1000ObjectsPerMonth ?? 0);

  const usesIt = storageLines.some((line) => line.key.startsWith("it-")) || itObjects > 0;
  const usesArchive = storageLines.some((line) =>
    ["glacier-flexible", "glacier-deep-archive"].includes(line.key),
  );
  if (usesArchive) {
    notes.push(
      "Glacier restores bill restore requests per 1,000 on top of the per-GB retrieval fee (Deep Archive: $0.10 standard / $0.025 bulk; Glacier Flexible: $0.05), and restores can take minutes-to-hours at standard/bulk speed.",
    );
  }
  if (usesIt) {
    notes.push(
      "Intelligent-Tiering archive tiers bill retrieval like the matching Glacier class in practice; this calculator does not model Intelligent-Tiering retrieval fees.",
    );
  }
  const earlyDelete = storageLines.filter((line) => {
    const meta = pricingDoc.classes.find((c) => c.id === line.key) ??
      pricingDoc.classes.find((c) => c.id === line.key.replace(/^it-.*$/, "intelligent-tiering"));
    return meta?.minimumDays != null;
  });
  if (earlyDelete.length > 0 && Object.values(inputs.transitions ?? {}).some((v) => v > 0)) {
    notes.push(
      "Classes with minimum storage durations (Standard-IA / One Zone-IA 30 days, Glacier IR / Flexible 90 days, Deep Archive 180 days) charge prorated early-deletion fees for objects deleted sooner.",
    );
  }

  const total = storageTotal + requestsTotal + retrievalTotal + transitionsTotal + monitoringCost;
  const totalGb = storageLines.reduce((sum, line) => sum + line.gb, 0);
  return {
    ok: true,
    region: region.id,
    storage: { lines: storageLines, total: round(storageTotal) },
    requests: { lines: requestLines, total: round(requestsTotal) },
    retrieval: { lines: retrievalLines, total: round(retrievalTotal) },
    transitions: { lines: transitionLines, total: round(transitionsTotal) },
    monitoring: { objectsPerMonth: itObjects, cost: round(monitoringCost) },
    total: round(total),
    perTb: totalGb > 0 ? round((total / totalGb) * 1024, 2) : null,
    notes,
  };
}
