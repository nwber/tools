#!/usr/bin/env node
/**
 * Generates public/data/data-transfer-pricing.json — per-region data-transfer
 * prices for the /data-transfer/ estimator.
 *
 * Usage:
 *   node scripts/generate-data-transfer-pricing.mjs [--regions a,b] [--keep-downloads <dir>]
 *
 * Sources (public AWS Price List API bulk files, no auth):
 *   https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/index.json
 *   https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonVPC/current/index.json
 *   https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/<region>/index.json
 *
 * Why three offers:
 *   - AWSDataTransfer holds internet egress tiers (DataTransfer-Out-Bytes),
 *     the cross-AZ rate (DataTransfer-Regional-Bytes), the 100 GB/month
 *     global free-tier row, and the inter-region pair matrix
 *     (<SRC>-<DST>-AWS-Out-Bytes).
 *   - AmazonVPC holds interface endpoint (PrivateLink) pricing
 *     (VpcEndpoint-Hours / VpcEndpoint-Bytes). Its usagetype prefixes double
 *     as the region codes used by the pair matrix (e.g. eu-west-1 -> "EU").
 *   - AmazonEC2 holds NAT gateway pricing (NatGateway-Hours / NatGateway-Bytes).
 *     The full EC2 offer is ~9 GB, so this script downloads the per-region
 *     files (~100-480 MB each, ~10 GB total) and deletes each after parsing.
 *     It re-execs itself with a larger V8 heap for those parses.
 *
 * Real-world quirks this encodes (verified against the current offers; the
 * script fails loudly if AWS renames something):
 *   - us-east-1's internet-egress, cross-AZ, and NAT usagetypes are bare
 *     ("DataTransfer-Out-Bytes"); every other region prefixes them, and the
 *     prefixing differs per offer (us-east-1's VPC endpoint usagetype is
 *     "USE1-VpcEndpoint-Hours" while its NAT one is bare). Every lookup tries
 *     the prefixed name first and falls back to the bare one, expecting
 *     exactly one match.
 *   - The AWSDataTransfer offer has no regionCode attribute at all; products
 *     are keyed by location name ("US East (N. Virginia)", "EU (Ireland)").
 *     The script learns each region's pricing location name from its EC2
 *     offer, so the two naming schemes are matched without guesswork.
 *   - Inter-region inbound (-AWS-In-Bytes) is $0.00; only outbound is billed.
 *   - The 100 GB/month internet-egress free tier is a separate global SKU
 *     (Global-DataTransfer-Out-Bytes, 0-100 GB at $0).
 */

import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DT_OFFER_URL =
  "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/index.json";
const VPC_OFFER_URL =
  "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonVPC/current/index.json";
const EC2_OFFER_URL = (region) =>
  `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/${region}/index.json`;

const REGIONS_FILE = "public/data/aws-regions.json";
const OUT_FILE = "public/data/data-transfer-pricing.json";

// The per-region EC2 files are up to ~480 MB of JSON; JSON.parse needs a
// generous heap. Re-exec once with a bigger V8 limit instead of asking the
// caller to remember the flag.
const HEAP_MB = 8192;
if (!process.env.DT_PRICING_HEAP_OK) {
  const rerun = spawnSync(
    process.execPath,
    [`--max-old-space-size=${HEAP_MB}`, ...process.argv.slice(1)],
    { stdio: "inherit", env: { ...process.env, DT_PRICING_HEAP_OK: "1" } },
  );
  process.exit(rerun.status ?? 1);
}

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function downloadJson(url, dest, label) {
  console.error(`Downloading ${label} (${url})...`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label} download failed: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
  return JSON.parse(await readFile(dest, "utf8"));
}

async function loadSmallOffer(url, localPath, label) {
  if (localPath) {
    console.error(`Reading ${label} offer from ${localPath}`);
    return JSON.parse(await readFile(localPath, "utf8"));
  }
  return downloadJson(url, path.join(os.tmpdir(), `dt-pricing-${label}.json`), label);
}

/** All on-demand price dimensions for one product. */
function dimensions(offer, sku) {
  const out = [];
  for (const term of Object.values(offer.terms.OnDemand[sku] ?? {})) {
    for (const dim of Object.values(term.priceDimensions)) {
      out.push({
        usd: Number(dim.pricePerUnit.USD),
        unit: dim.unit,
        beginRange: dim.beginRange,
        endRange: dim.endRange,
      });
    }
  }
  return out;
}

/**
 * Find exactly one product by usagetype and attribute filter; fails loudly on
 * zero or multiple matches.
 */
function findProduct(offer, usagetypes, filter, label) {
  const wanted = new Set(usagetypes);
  const hits = Object.entries(offer.products).filter(([, product]) => {
    const attrs = product.attributes ?? {};
    return wanted.has(attrs.usagetype) && (filter ? filter(attrs) : true);
  });
  if (hits.length !== 1) {
    throw new Error(
      `${label}: expected exactly one product for ${[...wanted].join(" / ")}, found ${hits.length}`,
    );
  }
  return { sku: hits[0][0], attrs: hits[0][1].attributes ?? {} };
}

/** A single price dimension, asserting count and unit. */
function singleDimension(offer, usagetypes, filter, unit, label) {
  const { sku, attrs } = findProduct(offer, usagetypes, filter, label);
  const dims = dimensions(offer, sku);
  if (dims.length !== 1) {
    throw new Error(`${label}: expected 1 price dimension, found ${dims.length}`);
  }
  if (dims[0].unit !== unit) {
    throw new Error(`${label}: expected unit ${unit}, found ${dims[0].unit}`);
  }
  return { usd: dims[0].usd, usagetype: attrs.usagetype, location: attrs.location };
}

/** Both the prefixed and the bare usagetype spellings for a suffix. */
const spellings = (prefix, suffix) => (prefix ? [`${prefix}-${suffix}`, suffix] : [suffix]);

/** Parse tiered per-GB dimensions into ascending, contiguous tiers. */
function readTiers(offer, sku, label) {
  const dims = dimensions(offer, sku).sort(
    (a, b) => Number(a.beginRange) - Number(b.beginRange),
  );
  const tiers = [];
  let expectedBegin = 0;
  for (const dim of dims) {
    if (dim.unit !== "GB") throw new Error(`${label}: expected GB unit, found ${dim.unit}`);
    if (Number(dim.beginRange) !== expectedBegin) {
      throw new Error(`${label}: tiers are not contiguous at ${dim.beginRange}`);
    }
    const openEnded = /Inf/i.test(String(dim.endRange));
    const upToGb = openEnded ? null : Number(dim.endRange);
    tiers.push({ upToGb, perGbUsd: dim.usd });
    if (upToGb !== null) expectedBegin = upToGb;
  }
  if (tiers.length === 0 || tiers[tiers.length - 1].upToGb !== null) {
    throw new Error(`${label}: last tier is not open-ended`);
  }
  return tiers;
}

/** The dataset's per-region prices for one region, or throw. */
function extractRegion({ code, name }, { vpc, ec2, dt }) {
  // Interface endpoint prices (AmazonVPC offer, keyed by regionCode).
  const endpointProducts = Object.entries(vpc.products).filter(([, p]) => {
    const attrs = p.attributes ?? {};
    return (
      attrs.regionCode === code && /(^|-)VpcEndpoint-(Hours|Bytes)$/.test(attrs.usagetype ?? "")
    );
  });
  const endpointHour = endpointProducts.filter(([, p]) =>
    /VpcEndpoint-Hours$/.test(p.attributes.usagetype),
  );
  const endpointGb = endpointProducts.filter(([, p]) =>
    /VpcEndpoint-Bytes$/.test(p.attributes.usagetype),
  );
  if (endpointHour.length !== 1 || endpointGb.length !== 1) {
    throw new Error(
      `interface endpoint: expected 1 Hours + 1 Bytes product, found ${endpointHour.length} + ${endpointGb.length}`,
    );
  }
  const hourDims = dimensions(vpc, endpointHour[0][0]);
  if (hourDims.length !== 1 || hourDims[0].unit !== "Hrs") {
    throw new Error("interface endpoint hours: unexpected dimensions");
  }
  const endpointGbTiers = readTiers(
    vpc,
    endpointGb[0][0],
    `[${code}] interface endpoint bytes`,
  );
  const endpointUsagetype = endpointHour[0][1].attributes.usagetype;
  const prefix = endpointUsagetype.replace(/-VpcEndpoint-Hours$/, "");
  if (prefix === endpointUsagetype) {
    throw new Error(`interface endpoint: could not derive prefix from ${endpointUsagetype}`);
  }

  // NAT gateway (AmazonEC2 regional offer). Match by regionCode/location so
  // bare (us-east-1) and prefixed usagetypes both work.
  const natCandidates = Object.entries(ec2.products).filter(([, p]) => {
    const attrs = p.attributes ?? {};
    return (
      /(^|-)NatGateway-Hours$/.test(attrs.usagetype ?? "") &&
      attrs.operation === "NatGateway" &&
      (attrs.regionCode === code || attrs.location === name)
    );
  });
  if (natCandidates.length !== 1) {
    throw new Error(`NAT gateway hours: expected 1 product, found ${natCandidates.length}`);
  }
  const natHourDims = dimensions(ec2, natCandidates[0][0]);
  if (natHourDims.length !== 1 || natHourDims[0].unit !== "Hrs") {
    throw new Error("NAT gateway hours: unexpected dimensions");
  }
  const natLocation = natCandidates[0][1].attributes.location;
  if (!natLocation) throw new Error("NAT gateway hours: no location attribute");
  const natBytes = singleDimension(
    ec2,
    spellings(prefix, "NatGateway-Bytes"),
    (attrs) => attrs.operation === "NatGateway" && attrs.location === natLocation,
    "GB",
    `[${code}] NAT gateway bytes`,
  );

  // Internet egress tiers + cross-AZ rate (AWSDataTransfer offer).
  const egressProduct = findProduct(
    dt,
    spellings(prefix, "DataTransfer-Out-Bytes"),
    (attrs) => (attrs.fromLocation ?? attrs.location) === natLocation,
    `[${code}] internet egress`,
  );
  const internetOutTiers = readTiers(dt, egressProduct.sku, `[${code}] internet egress`);
  const crossAz = singleDimension(
    dt,
    spellings(prefix, "DataTransfer-Regional-Bytes"),
    (attrs) => (attrs.fromLocation ?? attrs.location) === natLocation,
    "GB",
    `[${code}] cross-AZ`,
  );

  return {
    prefix,
    location: natLocation,
    prices: {
      natGateway: { hourUsd: natHourDims[0].usd, gbUsd: natBytes.usd },
      interfaceEndpoint: { hourUsd: hourDims[0].usd, gbTiers: endpointGbTiers },
      crossAzPerGb: crossAz.usd,
      internetOutTiers,
      interRegionOut: {},
    },
  };
}

async function main() {
  const regionFilter = arg("--regions")
    ? new Set(arg("--regions").split(",").map((code) => code.trim()))
    : null;
  const keepDir = arg("--keep-downloads");

  const catalog = JSON.parse(await readFile(REGIONS_FILE, "utf8"));
  const regions = catalog.regions.filter((r) => !regionFilter || regionFilter.has(r.code));
  if (regions.length === 0) throw new Error("no regions selected");

  const dt = await loadSmallOffer(DT_OFFER_URL, arg("--datatransfer"), "AWSDataTransfer");
  const vpc = await loadSmallOffer(VPC_OFFER_URL, arg("--vpc"), "AmazonVPC");
  console.error(
    `AWSDataTransfer offer ${dt.version}; AmazonVPC offer ${vpc.version}`,
  );

  // The 100 GB/month global internet-egress free tier is its own SKU.
  const freeTier = findProduct(
    dt,
    ["Global-DataTransfer-Out-Bytes"],
    (attrs) => attrs.fromLocation === "Global" || attrs.location === "Global",
    "global free tier",
  );
  const freeDims = dimensions(dt, freeTier.sku);
  if (freeDims.length !== 1 || freeDims[0].usd !== 0) {
    throw new Error("free tier is not a single $0 dimension");
  }
  const internetOutFreeGb = Number(freeDims[0].endRange);
  if (!Number.isFinite(internetOutFreeGb)) throw new Error("free tier has no finite end range");

  const downloadsDir = keepDir ?? path.join(os.tmpdir(), "dt-pricing-ec2");
  await mkdir(downloadsDir, { recursive: true });

  const prefixByRegion = new Map();
  const locationByRegion = new Map();
  const prices = {};
  const skipped = [];
  const ec2Versions = new Set();

  for (const region of regions) {
    const { code } = region;
    const ec2File = path.join(downloadsDir, `ec2-${code}.json`);
    try {
      let ec2;
      try {
        ec2 = JSON.parse(await readFile(ec2File, "utf8"));
        console.error(`[${code}] using cached EC2 offer`);
      } catch {
        ec2 = await downloadJson(EC2_OFFER_URL(code), ec2File, `EC2/${code}`);
      }
      ec2Versions.add(ec2.version);

      const extracted = extractRegion(region, { vpc, ec2, dt });
      prefixByRegion.set(code, extracted.prefix);
      locationByRegion.set(code, extracted.location);
      prices[code] = extracted.prices;
      console.error(
        `[${code}] NAT $${extracted.prices.natGateway.hourUsd}/h + $${extracted.prices.natGateway.gbUsd}/GB, ` +
          `endpoint $${extracted.prices.interfaceEndpoint.hourUsd}/h + $${extracted.prices.interfaceEndpoint.gbTiers[0].perGbUsd}/GB, ` +
          `cross-AZ $${extracted.prices.crossAzPerGb}/GB, ` +
          `egress ${extracted.prices.internetOutTiers.map((t) => `$${t.perGbUsd}`).join("/")}`,
      );
      if (!keepDir) await rm(ec2File, { force: true });
    } catch (error) {
      skipped.push(`${code}: ${error.message}`);
      delete prices[code];
      console.error(`[${code}] SKIPPED: ${error.message}`);
    }
  }

  // --- inter-region pair matrix (outbound only; inbound is $0) ---
  // Two pairs in the current offer have no published outbound rate (outbound
  // from Asia Pacific (Jakarta) to Osaka and to Sao Paulo). Rather than
  // guessing a substitute, those keys stay absent and the tool surfaces the
  // gap; missingPairs records them for review.
  const usable = regions.filter((r) => prices[r.code]);
  const missingPairs = [];
  for (const src of usable) {
    for (const dst of usable) {
      if (src.code === dst.code) continue;
      const usagetype = `${prefixByRegion.get(src.code)}-${prefixByRegion.get(dst.code)}-AWS-Out-Bytes`;
      const hits = Object.entries(dt.products).filter(
        ([, p]) =>
          p.attributes?.usagetype === usagetype &&
          p.attributes?.fromLocation === locationByRegion.get(src.code) &&
          p.attributes?.toLocation === locationByRegion.get(dst.code),
      );
      if (hits.length !== 1) {
        missingPairs.push(`${src.code}->${dst.code}`);
        console.error(`[pair] no published rate for ${src.code}->${dst.code} (${usagetype})`);
        continue;
      }
      const dims = dimensions(dt, hits[0][0]);
      if (dims.length !== 1 || dims[0].unit !== "GB") {
        throw new Error(`pair ${src.code}->${dst.code}: unexpected dimensions`);
      }
      prices[src.code].interRegionOut[dst.code] = dims[0].usd;
    }
  }

  const output = {
    generatedBy: "scripts/generate-data-transfer-pricing.mjs",
    sources: {
      datatransfer_offer: DT_OFFER_URL,
      datatransfer_offer_version: dt.version,
      vpc_offer: VPC_OFFER_URL,
      vpc_offer_version: vpc.version,
      ec2_offer_template: EC2_OFFER_URL("{region}"),
      ec2_offer_versions: [...ec2Versions],
    },
    internetOutFreeGb,
    groups: catalog.groups,
    regions: usable.map(({ code, name, group }) => ({ code, name, group })),
    prices,
    skippedRegions: skipped,
    // Inter-region pairs with no published outbound rate in the offer; the
    // tool shows a note instead of a number for those destinations.
    missingPairs,
    notes: [
      "Internet egress is tiered per region and applies beyond the 100 GB/month free tier, which AWS aggregates across all services and regions; this tool applies it to the entered internet-egress volume only.",
      "Cross-AZ data transfer (DataTransfer-Regional-Bytes) is $/GB in each direction between resources in different AZs; a byte transferred and answered bills twice the rate.",
      "Inter-region inbound is $0.00 in the current price list; only the outbound direction is billed, at the pair rate in interRegionOut. Pairs without a published rate are listed in missingPairs and are flagged (not priced) by the tool.",
      "Interface endpoint prices are per endpoint per AZ (VpcEndpoint-Hours) plus tiered $/GB processed (VpcEndpoint-Bytes: $0.01 up to 1 PB/month, less above); gateway endpoints (S3, DynamoDB) are free.",
      "NAT gateway prices are the classic NAT gateway (hourly + per-GB processed); the newer regional NAT gateway is priced identically in every region sampled.",
      "Not modeled: VPC peering / Transit Gateway charges, CloudFront, S3-specific egress rates, public IPv4 address charges, and the legacy 1 GB regional free-tier SKU.",
    ],
  };

  await writeFile(path.resolve(OUT_FILE), JSON.stringify(output, null, 2) + "\n");
  console.error(`Wrote ${OUT_FILE}: ${usable.length} regions (${skipped.length} skipped)`);
  for (const entry of skipped) console.error(`  skipped ${entry}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
