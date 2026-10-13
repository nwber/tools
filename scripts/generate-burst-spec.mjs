#!/usr/bin/env node
/**
 * Generates public/data/ec2-burst-spec.json — the burstable-instance spec and
 * comparison dataset for the EC2 burst calculator (todo phase 2, scoped to
 * t3a / t4g / t8i).
 *
 * Usage:
 *   node scripts/generate-burst-spec.mjs [--input <instances.json>]
 *
 * Data flow:
 *   - instance specs, on-demand / RI / Savings-Plan prices: the Vantage
 *     ec2instances.info dataset (https://instances.vantage.sh/instances.json,
 *     which mirrors the AWS Price List API). Pass --input to reuse a local
 *     copy instead of downloading the ~300 MB file.
 *   - CPU-credit baselines and earn rates: AWS docs, hand-curated below with
 *     citations (the dataset's units are not trustworthy for these).
 *   - Unlimited-mode surcharge rates: AWS EC2 on-demand pricing page.
 *
 * The comparison rule (per the phase-2 scope): for every burstable size, the
 * candidate is the cheapest non-burstable instance type with the *same
 * physical processor* and the *same vCPU count* whose memory is the smallest
 * available that is >= the burstable's memory. When an exact vCPU+memory
 * twin exists, that is what the rule selects ("exact": true).
 *
 * The output is committed; this script is run manually when a refresh is
 * wanted, so the diff is reviewable.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DATASET_URL = "https://instances.vantage.sh/instances.json";
const OUT_FILE = "public/data/ec2-burst-spec.json";

// ---------------------------------------------------------------------------
// Curated CPU-credit specifications (AWS docs).
//
// Sources:
//   https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-credits-baseline-concepts.html#earning-CPU-credits
//   https://aws.amazon.com/ec2/pricing/on-demand/#T8i.2FT4g.2FT3.2FT3a.2FT2_Unlimited_Mode_Pricing
//
// creditsPerHour and maxCredits are per instance; the max is 24h of accrual.
// Unlimited surcharges are USD per vCPU-hour (Linux). The pricing page lists
// T8i at $0.06 and T4g at $0.04; T3a shares the T3 rate ($0.05).
// ---------------------------------------------------------------------------
const CREDIT_SIZES = {
  nano: { creditsPerHour: 6, maxCredits: 144 },
  micro: { creditsPerHour: 12, maxCredits: 288 },
  small: { creditsPerHour: 24, maxCredits: 576 },
  medium: { creditsPerHour: 24, maxCredits: 576 },
  large: { creditsPerHour: 36, maxCredits: 864 },
  xlarge: { creditsPerHour: 96, maxCredits: 2304 },
  "2xlarge": { creditsPerHour: 192, maxCredits: 4608 },
};

const FAMILIES = {
  t3a: {
    processor: "AMD EPYC 7571",
    unlimitedSurchargePerVcpuHour: 0.05,
    sizes: ["nano", "micro", "small", "medium", "large", "xlarge", "2xlarge"],
  },
  t4g: {
    processor: "AWS Graviton2 Processor",
    unlimitedSurchargePerVcpuHour: 0.04,
    sizes: ["nano", "micro", "small", "medium", "large", "xlarge", "2xlarge"],
  },
  t8i: {
    processor: "Intel Xeon Scalable (Granite Rapids)",
    unlimitedSurchargePerVcpuHour: 0.06,
    sizes: ["nano", "micro", "small", "medium"],
  },
};

const REGION_NAMES = {
  "us-east-1": "US East (N. Virginia)",
  "us-east-2": "US East (Ohio)",
  "us-west-1": "US West (N. California)",
  "us-west-2": "US West (Oregon)",
  "ca-central-1": "Canada (Central)",
  "eu-west-1": "Europe (Ireland)",
  "eu-west-2": "Europe (London)",
  "eu-west-3": "Europe (Paris)",
  "eu-central-1": "Europe (Frankfurt)",
  "ap-south-1": "Asia Pacific (Mumbai)",
  "ap-southeast-1": "Asia Pacific (Singapore)",
  "ap-southeast-2": "Asia Pacific (Sydney)",
  "ap-northeast-1": "Asia Pacific (Tokyo)",
  "ap-northeast-2": "Asia Pacific (Seoul)",
  "ap-southeast-5": "Asia Pacific (Malaysia)",
  "ap-south-2": "Asia Pacific (Hyderabad)",
  "ap-east-1": "Asia Pacific (Hong Kong)",
  "me-south-1": "Middle East (Bahrain)",
  "af-south-1": "Africa (Cape Town)",
  "sa-east-1": "South America (São Paulo)",
};

/** Extracts the price terms we expose from one instance's regional pricing. */
function priceTerms(instance, region) {
  const linux = instance.pricing?.[region]?.linux;
  if (!linux?.ondemand) return null;
  const reserved = linux.reserved ?? {};
  const num = (value) => (value !== undefined ? Number(value) : null);
  return {
    onDemand: Number(linux.ondemand),
    // Standard RIs, no upfront, effective hourly rate.
    ri1yrNoUpfront: num(reserved["yrTerm1Standard.noUpfront"]),
    ri3yrNoUpfront: num(reserved["yrTerm3Standard.noUpfront"]),
    // ec2instances.info's "savings" terms track Compute Savings Plans
    // (they match convertible RI rates); expose as an estimate.
    sp1yrNoUpfront: num(reserved["yrTerm1Savings.noUpfront"]),
  };
}

function isCandidateType(instance) {
  return (
    instance.generation === "current" &&
    !instance.base_performance && // excludes every burstable type
    !instance.is_bare_metal
  );
}

/** The phase-2 comparison rule. Returns candidate types sorted cheapest-first. */
function compareCandidates(catalog, processor, vcpu, memoryGiB) {
  const sameShape = catalog.filter(
    (i) =>
      isCandidateType(i) &&
      i.physical_processor === processor &&
      i.vCPU === vcpu &&
      i.memory >= memoryGiB,
  );
  if (sameShape.length === 0) return [];
  const minMemory = Math.min(...sameShape.map((i) => i.memory));
  const candidates = sameShape
    .filter((i) => i.memory === minMemory)
    .map((i) => ({
      type: i.instance_type,
      vcpu: i.vCPU,
      memoryGiB: i.memory,
      exact: i.memory === memoryGiB,
      onDemandUsEast1: Number(
        i.pricing?.["us-east-1"]?.linux?.ondemand ?? Number.POSITIVE_INFINITY,
      ),
    }))
    .sort((a, b) => a.onDemandUsEast1 - b.onDemandUsEast1);
  return candidates;
}

async function loadCatalog(inputPath) {
  if (inputPath) {
    console.error(`Reading catalog from ${inputPath}`);
    return JSON.parse(await readFile(inputPath, "utf8"));
  }
  console.error(`Downloading catalog from ${DATASET_URL} (large file)...`);
  const response = await fetch(DATASET_URL);
  if (!response.ok) throw new Error(`catalog download failed: ${response.status}`);
  return response.json();
}

async function main() {
  const inputIndex = process.argv.indexOf("--input");
  const inputPath = inputIndex >= 0 ? process.argv[inputIndex + 1] : undefined;
  const catalog = await loadCatalog(inputPath);
  const byType = new Map(catalog.map((i) => [i.instance_type, i]));

  // Sizes + comparisons.
  const sizes = [];
  const comparisons = [];
  const neededTypes = [];

  for (const [family, spec] of Object.entries(FAMILIES)) {
    for (const size of spec.sizes) {
      const type = `${family}.${size}`;
      const instance = byType.get(type);
      if (!instance) throw new Error(`${type} missing from the catalog`);
      if (instance.physical_processor !== spec.processor) {
        throw new Error(
          `${type} processor changed: ${instance.physical_processor} != ${spec.processor}`,
        );
      }
      const credits = CREDIT_SIZES[size];
      const baselinePct = (credits.creditsPerHour / instance.vCPU / 60) * 100;
      sizes.push({
        type,
        family,
        size,
        vcpu: instance.vCPU,
        memoryGiB: instance.memory,
        baselinePct: Math.round(baselinePct * 100) / 100,
        creditsPerHour: credits.creditsPerHour,
        maxCredits: credits.maxCredits,
        // Minutes at 100% CPU on every vCPU from a full bucket.
        fullBurstMinutes: (credits.maxCredits / instance.vCPU / 60) * 60,
      });
      neededTypes.push(type);

      const candidates = compareCandidates(
        catalog,
        spec.processor,
        instance.vCPU,
        instance.memory,
      );
      if (candidates.length === 0) {
        throw new Error(`${type}: no non-burstable candidate with the same processor/vCPU`);
      }
      const chosen = candidates[0];
      // Only the burstable and its chosen candidate gate region availability;
      // the alternatives are informational.
      neededTypes.push(type, chosen.type);
      comparisons.push({
        burstable: type,
        candidate: chosen.type,
        exact: chosen.exact,
        candidateVcpu: chosen.vcpu,
        candidateMemoryGiB: chosen.memoryGiB,
        candidates: candidates.map((c) => c.type),
      });
    }
  }

  // Regions: every needed type must be priced there, and we need a name.
  const uniqueNeeded = [...new Set(neededTypes)];
  const priceableRegions = uniqueNeeded
    .map((t) => new Set(Object.keys(byType.get(t).pricing ?? {})))
    .reduce((acc, next) => new Set([...acc].filter((r) => next.has(r))));
  const regions = [...priceableRegions]
    .filter((region) => {
      if (!REGION_NAMES[region]) {
        throw new Error(`region ${region} has no display name; add it to REGION_NAMES`);
      }
      return uniqueNeeded.every((t) => priceTerms(byType.get(t), region));
    })
    .sort()
    .map((region) => ({ id: region, name: REGION_NAMES[region] }));

  // Prices for both sides of every comparison.
  const prices = {};
  for (const comparison of comparisons) {
    const burstable = byType.get(comparison.burstable);
    const candidate = byType.get(comparison.candidate);
    prices[comparison.burstable] = {
      burstable: Object.fromEntries(
        regions.map((r) => [r.id, priceTerms(burstable, r.id)]),
      ),
      candidate: Object.fromEntries(
        regions.map((r) => [r.id, priceTerms(candidate, r.id)]),
      ),
    };
  }

  const output = {
    generatedBy: "scripts/generate-burst-spec.mjs",
    sources: {
      specs_prices: DATASET_URL,
      credit_tables:
        "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-credits-baseline-concepts.html#earning-CPU-credits",
      unlimited_pricing:
        "https://aws.amazon.com/ec2/pricing/on-demand/#T8i.2FT4g.2FT3.2FT3a.2FT2_Unlimited_Mode_Pricing",
    },
    families: Object.fromEntries(
      Object.entries(FAMILIES).map(([name, spec]) => [
        name,
        {
          processor: spec.processor,
          unlimitedSurchargePerVcpuHour: spec.unlimitedSurchargePerVcpuHour,
        },
      ]),
    ),
    regions,
    sizes,
    comparisons,
    prices,
  };

  const outPath = path.resolve(OUT_FILE);
  await writeFile(outPath, JSON.stringify(output, null, 2) + "\n");
  console.error(
    `Wrote ${OUT_FILE}: ${sizes.length} sizes, ${regions.length} regions, ${comparisons.length} comparisons`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
