#!/usr/bin/env node
/**
 * Generates public/data/s3-pricing.json — per-region S3 prices for the
 * storage classes in the S3 cost calculator.
 *
 * Usage:
 *   node scripts/generate-s3-pricing.mjs [--s3 <s3-offer.json>] [--gda <gda-offer.json>]
 *
 * Sources (public AWS Price List API bulk files, no auth):
 *   https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/index.json
 *   https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3GlacierDeepArchive/current/index.json
 *
 * Real-world quirks the mapping below encodes (all verified against the
 * current offers, with loud failures if AWS renames something):
 *   - us-east-1 uses bare usagetypes; other regions prefix them (e.g.
 *     "EUW1-TimedStorage-SIA-ByteHrs"). The prefix is derived per region.
 *   - Requests-Tier3/Tier4 are overloaded: the specific meaning lives in the
 *     price dimension's description ("Glacier Requests", "transitions to
 *     Standard-Infrequent Access", "Lifecycle requests to Glacier Deep
 *     Archive", ...), so those entries are matched by description.
 *   - Standard-Retrieval-Bytes / Bulk-Retrieval-Bytes appear once for
 *     Glacier Flexible and once for Deep Archive; the GDA variants mention
 *     "Glacier Deep Archive" in the description.
 *   - Deep Archive prices come from the separate AmazonS3GlacierDeepArchive
 *     offer.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const S3_OFFER_URL =
  "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/index.json";
const GDA_OFFER_URL =
  "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3GlacierDeepArchive/current/index.json";
const OUT_FILE = "public/data/s3-pricing.json";

/** Class metadata surfaced to the UI (order = display order). */
const CLASSES = [
  { id: "standard", name: "S3 Standard", minimumDays: null, kind: "storage" },
  { id: "intelligent-tiering", name: "S3 Intelligent-Tiering", minimumDays: null, kind: "tiered" },
  { id: "standard-ia", name: "S3 Standard-IA", minimumDays: 30, kind: "storage" },
  { id: "onezone-ia", name: "S3 One Zone-IA", minimumDays: 30, kind: "storage" },
  { id: "glacier-ir", name: "S3 Glacier Instant Retrieval", minimumDays: 90, kind: "storage" },
  { id: "glacier-flexible", name: "S3 Glacier Flexible Retrieval", minimumDays: 90, kind: "storage" },
  { id: "glacier-deep-archive", name: "S3 Glacier Deep Archive", minimumDays: 180, kind: "storage" },
];

const TB = 1024; // GB per TiB (AWS prices "TB" as 1024 GB in the price list)

async function loadOffer(url, inputPath, label) {
  if (inputPath) {
    console.error(`Reading ${label} offer from ${inputPath}`);
    return JSON.parse(await readFile(inputPath, "utf8"));
  }
  console.error(`Downloading ${label} offer from ${url}...`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} download failed: ${response.status}`);
  return response.json();
}

/** All on-demand price dimensions for one product, as {usd, unit, description}. */
function dimensions(offer, sku) {
  const out = [];
  for (const term of Object.values(offer.terms.OnDemand[sku] ?? {})) {
    for (const dim of Object.values(term.priceDimensions)) {
      out.push({
        usd: Number(dim.pricePerUnit.USD),
        unit: dim.unit,
        description: dim.description ?? "",
      });
    }
  }
  return out;
}

/** Index: (regionCode, usagetype) -> products, with operation for disambiguation. */
function indexByRegion(offer) {
  const index = new Map();
  for (const [sku, product] of Object.entries(offer.products)) {
    const attrs = product.attributes ?? {};
    const regionCode = attrs.regionCode;
    const usagetype = attrs.usagetype;
    if (!regionCode || !usagetype) continue;
    const key = `${regionCode}\t${usagetype}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push({
      sku,
      location: attrs.location,
      operation: attrs.operation ?? "",
      dimensions: dimensions(offer, sku),
    });
  }
  return index;
}

/**
 * Resolve one price line in (index, region, prefix) by usagetype and the
 * `operation` product attribute (the discriminator for overloaded usagetypes
 * like Requests-Tier3/Tier4 and the Retrieval-Bytes pairs). Fails loudly on
 * absence or ambiguity.
 */
function resolve(index, region, prefix, usagetype, operation, label) {
  const entries = (index.get(`${region}\t${prefix + usagetype}`) ?? []).filter(
    (entry) => operation === undefined || entry.operation === operation,
  );
  if (entries.length === 0) {
    throw new Error(
      `[${region}] ${label}: no product for ${prefix}${usagetype}` +
        (operation !== undefined ? ` (operation ${JSON.stringify(operation)})` : ""),
    );
  }
  const dims = entries.flatMap((entry) => entry.dimensions);
  if (dims.length !== 1) {
    throw new Error(
      `[${region}] ${label}: expected one price dimension, found ${dims.length} for ` +
        `${prefix}${usagetype} (operations: ${entries.map((e) => e.operation).join(", ")})`,
    );
  }
  return dims[0];
}

/** The usagetype prefix a region uses for `suffix` ("" for us-east-1). */
function regionPrefix(offer, suffix) {
  const result = new Map();
  // Only the bare usagetype or exactly one leading code segment (e.g.
  // "EUC2-TimedStorage-ByteHrs"); variants like "EUC2-Files-TimedStorage-..."
  // belong to other S3 features and must not be treated as the region prefix.
  const pattern = new RegExp(`^([A-Z0-9]+-)?${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  for (const product of Object.values(offer.products)) {
    const attrs = product.attributes ?? {};
    const usagetype = attrs.usagetype ?? "";
    const match = pattern.exec(usagetype);
    if (!regionCodeUsable(attrs) || !match) continue;
    const prefix = match[1] ?? "";
    if (result.has(attrs.regionCode) && result.get(attrs.regionCode) !== prefix) {
      throw new Error(
        `region ${attrs.regionCode} has conflicting prefixes: ` +
          `${result.get(attrs.regionCode)} vs ${prefix}`,
      );
    }
    result.set(attrs.regionCode, prefix);
  }
  return result;
}

const regionCodeUsable = (attrs) => typeof attrs.regionCode === "string";

/** Storage tiers ordered smallest-first, as [upToGb, pricePerGbMonth].
 * "next 450 TB" means the following 450 TB, so boundaries are cumulative.
 * A class with a single price dimension is simply unbounded. */
function storageTiers(dims, label) {
  const parsed = dims
    .map(({ usd, description }) => {
      const size = /(first|next|over)\s+(\d+)\s*TB/i.exec(description);
      const tier = description.toLowerCase();
      return {
        isOver: tier.includes("over"),
        sizeGb: size ? Number(size[2]) * TB : null,
        perGbMonth: usd,
      };
    })
    .sort((a, b) => {
      if (a.isOver) return 1;
      if (b.isOver) return -1;
      return (a.sizeGb ?? 0) - (b.sizeGb ?? 0);
    });
  if (parsed.length === 1) {
    return [{ upToGb: null, perGbMonth: parsed[0].perGbMonth }];
  }
  let boundary = 0;
  return parsed.map((tier) => {
    if (tier.isOver || tier.sizeGb === null) {
      return { upToGb: null, perGbMonth: tier.perGbMonth };
    }
    boundary += tier.sizeGb;
    return { upToGb: boundary, perGbMonth: tier.perGbMonth };
  });
}

function storageDims(index, region, prefix, usagetype, label) {
  const entries = index.get(`${region}\t${prefix}${usagetype}`) ?? [];
  if (entries.length === 0) {
    throw new Error(`[${region}] ${label}: no product for usagetype ${prefix}${usagetype}`);
  }
  const dims = entries.flatMap((entry) => entry.dimensions).filter((d) => d.unit === "GB-Mo");
  if (dims.length === 0) throw new Error(`[${region}] ${label}: no GB-Mo dimensions`);
  return dims;
}

const per1000 = (usd) => Math.round(usd * 1000 * 1e10) / 1e10;

async function main() {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const s3 = await loadOffer(S3_OFFER_URL, arg("--s3"), "S3");
  const gda = await loadOffer(GDA_OFFER_URL, arg("--gda"), "GDA");
  const s3Index = indexByRegion(s3);
  const gdaIndex = indexByRegion(gda);
  const prefixes = regionPrefix(s3, "TimedStorage-ByteHrs");
  const gdaPrefixes = regionPrefix(gda, "TimedStorage-GDA-ByteHrs");

  // Regions where every class is priced, with a display name from the offer.
  const nameByRegion = new Map();
  for (const product of Object.values(gda.products)) {
    const attrs = product.attributes ?? {};
    if (attrs.regionCode && attrs.location) nameByRegion.set(attrs.regionCode, attrs.location);
  }
  const unresolved = [];
  const regions = [];
  const prices = {};

  // Resolve every needed product first; a region only qualifies when nothing
  // throws. (Cheap: the offers are already in memory.)
  const candidates = [...prefixes.keys()]
    .filter(
      (region) =>
        nameByRegion.has(region) &&
        gdaPrefixes.has(region) &&
        !region.startsWith("us-gov-"),
    )
    .sort();

  for (const region of candidates) {
    const prefix = prefixes.get(region);
    const gdaPrefix = gdaPrefixes.get(region);
    try {
      const regionPrices = {};

      const standardTiers = storageTiers(
        storageDims(s3Index, region, prefix, "TimedStorage-ByteHrs", "standard storage"),
        "standard",
      );
      regionPrices["standard"] = {
        storageTiers: standardTiers,
        putPer1000: per1000(
          resolve(s3Index, region, prefix, "Requests-Tier1", "", "standard PUT").usd,
        ),
        getPer1000: per1000(
          resolve(s3Index, region, prefix, "Requests-Tier2", "", "standard GET").usd,
        ),
      };

      regionPrices["standard-ia"] = {
        storageTiers: [
          {
            upToGb: null,
            perGbMonth: storageDims(s3Index, region, prefix, "TimedStorage-SIA-ByteHrs", "SIA")[0]
              .usd,
          },
        ],
        putPer1000: per1000(
          resolve(s3Index, region, prefix, "Requests-SIA-Tier1", "", "SIA PUT").usd,
        ),
        getPer1000: per1000(
          resolve(s3Index, region, prefix, "Requests-SIA-Tier2", "", "SIA GET").usd,
        ),
        retrievalPerGb: resolve(s3Index, region, prefix, "Retrieval-SIA", "", "SIA retrieval")
          .usd,
        earlyDeletePerGbMonth: resolve(
          s3Index,
          region,
          prefix,
          "EarlyDelete-SIA",
          "",
          "SIA early delete",
        ).usd,
        transitionInPer1000: per1000(
          resolve(
            s3Index,
            region,
            prefix,
            "Requests-Tier4",
            "S3-SIATransition",
            "SIA transition in",
          ).usd,
        ),
      };

      regionPrices["onezone-ia"] = {
        storageTiers: [
          {
            upToGb: null,
            perGbMonth: storageDims(s3Index, region, prefix, "TimedStorage-ZIA-ByteHrs", "ZIA")[0]
              .usd,
          },
        ],
        putPer1000: per1000(
          resolve(s3Index, region, prefix, "Requests-ZIA-Tier1", "", "ZIA PUT").usd,
        ),
        getPer1000: per1000(
          resolve(s3Index, region, prefix, "Requests-ZIA-Tier2", "", "ZIA GET").usd,
        ),
        retrievalPerGb: resolve(s3Index, region, prefix, "Retrieval-ZIA", "", "ZIA retrieval")
          .usd,
        earlyDeletePerGbMonth: resolve(
          s3Index,
          region,
          prefix,
          "EarlyDelete-ZIA",
          "",
          "ZIA early delete",
        ).usd,
        transitionInPer1000: per1000(
          resolve(
            s3Index,
            region,
            prefix,
            "Requests-Tier4",
            "S3-ZIATransition",
            "ZIA transition in",
          ).usd,
        ),
      };

      regionPrices["glacier-ir"] = {
        storageTiers: [
          {
            upToGb: null,
            perGbMonth: storageDims(s3Index, region, prefix, "TimedStorage-GIR-ByteHrs", "GIR")[0]
              .usd,
          },
        ],
        putPer1000: per1000(
          resolve(s3Index, region, prefix, "Requests-GIR-Tier1", "", "GIR PUT").usd,
        ),
        getPer1000: per1000(
          resolve(s3Index, region, prefix, "Requests-GIR-Tier2", "", "GIR GET").usd,
        ),
        retrievalPerGb: resolve(s3Index, region, prefix, "Retrieval-GIR", "", "GIR retrieval")
          .usd,
        earlyDeletePerGbMonth: resolve(
          s3Index,
          region,
          prefix,
          "EarlyDelete-GIR",
          "",
          "GIR early delete",
        ).usd,
        transitionInPer1000: per1000(
          resolve(
            s3Index,
            region,
            prefix,
            "Requests-Tier4",
            "S3-GIRTransition",
            "GIR transition in",
          ).usd,
        ),
      };

      // Glacier Flexible uploads share the lifecycle-transition rate ($0.03/1k
      // in us-east-1); the price list exposes that rate on the
      // S3-GlacierTransition operation, so both use it here.
      const glacierTransition = per1000(
        resolve(
          s3Index,
          region,
          prefix,
          "Requests-Tier3",
          "S3-GlacierTransition",
          "Glacier Flexible transition/put",
        ).usd,
      );
      regionPrices["glacier-flexible"] = {
        storageTiers: [
          {
            upToGb: null,
            perGbMonth: storageDims(
              s3Index,
              region,
              prefix,
              "TimedStorage-GlacierByteHrs",
              "Glacier Flexible",
            )[0].usd,
          },
        ],
        putPer1000: glacierTransition,
        transitionInPer1000: glacierTransition,
        // GET/HEAD share the standard "GET and all other requests" rate.
        getPer1000: per1000(
          resolve(s3Index, region, prefix, "Requests-Tier2", "", "Glacier Flexible GET").usd,
        ),
        restoreRequestPer1000: per1000(
          resolve(
            s3Index,
            region,
            prefix,
            "Requests-Tier3",
            "RestoreObject",
            "Glacier Flexible restore requests",
          ).usd,
        ),
        retrievalPerGb: resolve(
          s3Index,
          region,
          prefix,
          "Standard-Retrieval-Bytes",
          "RestoreObject",
          "Glacier Flexible standard retrieval",
        ).usd,
        retrievalBulkPerGb: resolve(
          s3Index,
          region,
          prefix,
          "Bulk-Retrieval-Bytes",
          "RestoreObject",
          "Glacier Flexible bulk retrieval",
        ).usd,
        retrievalExpeditedPerGb: resolve(
          s3Index,
          region,
          prefix,
          "Expedited-Retrieval-Bytes",
          "",
          "Glacier Flexible expedited retrieval",
        ).usd,
        earlyDeletePerGbMonth: resolve(
          s3Index,
          region,
          prefix,
          "EarlyDelete-ByteHrs",
          "",
          "Glacier Flexible early delete",
        ).usd,
      };

      const gdaTransition = per1000(
        resolve(
          s3Index,
          region,
          prefix,
          "Requests-Tier3",
          "S3-GDATransition",
          "GDA transition",
        ).usd,
      );
      regionPrices["glacier-deep-archive"] = {
        storageTiers: [
          {
            upToGb: null,
            perGbMonth: storageDims(gdaIndex, region, gdaPrefix, "TimedStorage-GDA-ByteHrs", "GDA")[0]
              .usd,
          },
        ],
        putPer1000: gdaTransition,
        transitionInPer1000: gdaTransition,
        // GET/HEAD share the standard "GET and all other requests" rate.
        getPer1000: per1000(
          resolve(s3Index, region, prefix, "Requests-Tier2", "", "GDA GET").usd,
        ),
        restoreStandardPer1000: per1000(
          resolve(gdaIndex, region, gdaPrefix, "Requests-GDA-Tier3", "", "GDA standard restore requests").usd,
        ),
        restoreBulkPer1000: per1000(
          resolve(gdaIndex, region, gdaPrefix, "Requests-GDA-Tier5", "", "GDA bulk restore requests").usd,
        ),
        retrievalPerGb: resolve(
          gdaIndex,
          region,
          gdaPrefix,
          "Standard-Retrieval-Bytes",
          "DeepArchiveRestoreObject",
          "GDA standard retrieval",
        ).usd,
        retrievalBulkPerGb: resolve(
          gdaIndex,
          region,
          gdaPrefix,
          "Bulk-Retrieval-Bytes",
          "DeepArchiveRestoreObject",
          "GDA bulk retrieval",
        ).usd,
        earlyDeletePerGbMonth: resolve(
          gdaIndex,
          region,
          gdaPrefix,
          "EarlyDelete-GDA",
          "",
          "GDA early delete",
        ).usd,
      };

      const itTier = (usagetype, label) => ({
        storageTiers: storageTiers(
          storageDims(s3Index, region, prefix, usagetype, label),
          label,
        ),
      });
      regionPrices["intelligent-tiering"] = {
        tiers: {
          frequent: itTier("TimedStorage-INT-FA-ByteHrs", "IT frequent"),
          infrequent: itTier("TimedStorage-INT-IA-ByteHrs", "IT infrequent"),
          "archive-instant": itTier("TimedStorage-INT-AIA-ByteHrs", "IT archive instant"),
          archive: itTier("TimedStorage-INT-AA-ByteHrs", "IT archive"),
          "deep-archive": itTier("TimedStorage-INT-DAA-ByteHrs", "IT deep archive"),
        },
        monitoringPer1000ObjectsPerMonth: per1000(
          resolve(s3Index, region, prefix, "Monitoring-Automation-INT", "", "IT monitoring").usd,
        ),
        putPer1000: per1000(
          resolve(s3Index, region, prefix, "Requests-INT-Tier1", "", "IT PUT").usd,
        ),
        getPer1000: per1000(
          resolve(s3Index, region, prefix, "Requests-INT-Tier2", "", "IT GET").usd,
        ),
        transitionInPer1000: per1000(
          resolve(
            s3Index,
            region,
            prefix,
            "Requests-Tier4",
            "S3-INTTransition",
            "IT transition in",
          ).usd,
        ),
      };

      regions.push({ id: region, name: nameByRegion.get(region) });
      prices[region] = regionPrices;
    } catch (error) {
      unresolved.push(`${region}: ${error.message}`);
    }
  }

  const output = {
    generatedBy: "scripts/generate-s3-pricing.mjs",
    sources: {
      s3_offer: S3_OFFER_URL,
      s3_offer_version: s3.version,
      gda_offer: GDA_OFFER_URL,
      gda_offer_version: gda.version,
    },
    classes: CLASSES,
    regions,
    prices,
    // Regions that were skipped because not every class resolved there; kept
    // visible so gaps are reviewable instead of silent.
    skippedRegions: unresolved,
    notes: [
      "Glacier Flexible Retrieval bulk retrieval is currently $0.00 in the AWS price list.",
      "Deep Archive prices come from the separate AmazonS3GlacierDeepArchive offer file.",
      "Intelligent-Tiering archive tiers bill retrieval like the matching Glacier class; this calculator does not model IT retrieval fees.",
    ],
  };

  await writeFile(path.resolve(OUT_FILE), JSON.stringify(output, null, 2) + "\n");
  console.error(
    `Wrote ${OUT_FILE}: ${regions.length} regions (${unresolved.length} skipped)`,
  );
  if (unresolved.length > 0) {
    console.error("Skipped regions (inspect):");
    for (const entry of unresolved.slice(0, 10)) console.error(`  ${entry}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
