#!/usr/bin/env node
/**
 * Generates public/data/aws-regions.json — the region list and probe metadata
 * for the AWS Region Latency tool (/aws-latency/).
 *
 * Usage:
 *   node scripts/generate-aws-regions.mjs [--input <endpoints.json>]
 *
 * Sources:
 *   https://raw.githubusercontent.com/boto/botocore/develop/botocore/data/endpoints.json
 *     The canonical machine-readable region list. Display names come from its
 *     per-region `description` fields, which match the AWS docs region table
 *     (https://docs.aws.amazon.com/general/latest/gr/rande.html).
 *
 * Probe choice (verified empirically 2026-10-14, from this network):
 *   - GET https://dynamodb.<region>.amazonaws.com/ answers 200 with a tiny
 *     text body ("healthy: dynamodb.<region>.amazonaws.com") and no redirect,
 *     in every commercial region we probe — an explicit health contract.
 *   - The obvious alternatives redirect before answering: s3.<region> ->
 *     aws.amazon.com/s3/, ec2.<region> -> aws.amazon.com/ec2, sts.<region> ->
 *     aws.amazon.com/iam. A browser fetch would follow those to a marketing
 *     page, adding a second round trip and a different host's latency.
 *   - sqs/sns/kms/lambda/ssm also answer quickly (404/403/400, tiny bodies),
 *     but DynamoDB's response is the one designed to be a health check.
 *
 * Coordinates: city-level anchors for the /aws-latency/ map (the region's
 * metro area, e.g. Tokyo for ap-northeast-1). They place the dot on the map;
 * they are not data-center addresses. Cross-checked against the region
 * descriptions in the AWS docs region table. A new region without an entry
 * here fails loudly below instead of silently landing in the ocean.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ENDPOINTS_URL =
  "https://raw.githubusercontent.com/boto/botocore/develop/botocore/data/endpoints.json";
const OUT_FILE = "public/data/aws-regions.json";

/**
 * Regions deliberately not probed (owner request, 2026-10-14). Kept explicit
 * here so a regeneration cannot silently bring them back.
 */
const EXCLUDED_REGIONS = new Set(["il-central-1"]);

/**
 * City-level map anchors per region code (see the header note). Ordered by
 * group, then alphabetically, for easy diffing.
 */
const REGION_COORDS = {
  // us-canada
  "ca-central-1": [45.5017, -73.5673], // Montreal
  "ca-west-1": [51.0447, -114.0719], // Calgary
  "us-east-1": [39.0438, -77.4874], // Ashburn, Virginia
  "us-east-2": [39.9612, -82.9988], // Columbus, Ohio
  "us-west-1": [37.7749, -122.4194], // San Francisco
  "us-west-2": [45.5152, -122.6784], // Portland, Oregon
  // latin-america
  "mx-central-1": [20.5888, -100.388], // Querétaro
  "sa-east-1": [-23.5505, -46.6333], // São Paulo
  // europe
  "eu-central-1": [50.1109, 8.6821], // Frankfurt
  "eu-central-2": [47.3769, 8.5417], // Zurich
  "eu-north-1": [59.3293, 18.0686], // Stockholm
  "eu-south-1": [45.4642, 9.19], // Milan
  "eu-south-2": [40.4168, -3.7038], // Madrid
  "eu-west-1": [53.3498, -6.2603], // Dublin
  "eu-west-2": [51.5074, -0.1278], // London
  "eu-west-3": [48.8566, 2.3522], // Paris
  // asia-pacific
  "ap-east-1": [22.3193, 114.1694], // Hong Kong
  "ap-east-2": [25.033, 121.5654], // Taipei
  "ap-northeast-1": [35.6762, 139.6503], // Tokyo
  "ap-northeast-2": [37.5665, 126.978], // Seoul
  "ap-northeast-3": [34.6937, 135.5023], // Osaka
  "ap-south-1": [19.076, 72.8777], // Mumbai
  "ap-south-2": [17.385, 78.4867], // Hyderabad
  "ap-southeast-1": [1.3521, 103.8198], // Singapore
  "ap-southeast-2": [-33.8688, 151.2093], // Sydney
  "ap-southeast-3": [-6.2088, 106.8456], // Jakarta
  "ap-southeast-4": [-37.8136, 144.9631], // Melbourne
  "ap-southeast-5": [1.4927, 103.7414], // Johor Bahru, Malaysia
  "ap-southeast-6": [-36.8485, 174.7633], // Auckland
  "ap-southeast-7": [13.7563, 100.5018], // Bangkok
  // middle-east-africa
  "af-south-1": [-33.9249, 18.4241], // Cape Town
  "me-central-1": [25.2048, 55.2708], // Dubai, UAE
  "me-south-1": [26.2285, 50.586], // Manama, Bahrain
};

/** Probe template; {region} is replaced per region. */
const PROBE_TEMPLATE = "https://dynamodb.{region}.amazonaws.com/";

/** Group definitions, in display order. */
const GROUPS = [
  { id: "us-canada", label: "US & Canada" },
  { id: "latin-america", label: "Latin America" },
  { id: "europe", label: "Europe" },
  { id: "asia-pacific", label: "Asia Pacific" },
  { id: "middle-east-africa", label: "Middle East & Africa" },
];

/** Assign a region code to a group; unknown codes fail loudly below. */
function groupFor(code) {
  if (code.startsWith("us-") || code.startsWith("ca-")) return "us-canada";
  if (code === "sa-east-1" || code === "mx-central-1") return "latin-america";
  if (code.startsWith("eu-")) return "europe";
  if (code.startsWith("ap-")) return "asia-pacific";
  if (/^(af|me|il)-/.test(code)) return "middle-east-africa";
  return null;
}

async function main() {
  const inputIndex = process.argv.indexOf("--input");
  let raw;
  if (inputIndex !== -1) {
    const inputPath = process.argv[inputIndex + 1];
    if (!inputPath) throw new Error("--input needs a path");
    console.error(`Reading endpoints file from ${inputPath}`);
    raw = await readFile(inputPath, "utf8");
  } else {
    console.error(`Downloading ${ENDPOINTS_URL}...`);
    const response = await fetch(ENDPOINTS_URL);
    if (!response.ok) throw new Error(`endpoints download failed: ${response.status}`);
    raw = await response.text();
  }

  const endpoints = JSON.parse(raw);
  const partition = endpoints.partitions.find((p) => p.partition === "aws");
  if (!partition) throw new Error("no partition 'aws' in the endpoints file");

  const dynamodbRegions = new Set(Object.keys(partition.services.dynamodb?.endpoints ?? {}));
  const codes = Object.keys(partition.regions).sort();
  if (codes.length === 0) throw new Error("no regions in partition 'aws'");

  const problems = [];
  for (const code of EXCLUDED_REGIONS) {
    if (!partition.regions[code]) {
      problems.push(`excluded region ${code} is not in the endpoints file (typo?)`);
    }
  }

  const regions = [];
  for (const code of codes) {
    if (EXCLUDED_REGIONS.has(code)) continue;
    const description = partition.regions[code].description;
    if (!description) problems.push(`${code}: no description`);
    const group = groupFor(code);
    if (!group) problems.push(`${code}: no group mapping (new region prefix?)`);
    if (!dynamodbRegions.has(code)) problems.push(`${code}: no dynamodb endpoint to probe`);
    const coords = REGION_COORDS[code];
    if (!coords) problems.push(`${code}: no map coordinates (add them to REGION_COORDS)`);
    else if (Math.abs(coords[0]) > 90 || Math.abs(coords[1]) > 180) {
      problems.push(`${code}: map coordinates out of range: ${coords}`);
    }
    if (description && group && dynamodbRegions.has(code) && coords) {
      regions.push({ code, name: description, group, lat: coords[0], lon: coords[1] });
    }
  }
  if (problems.length > 0) {
    throw new Error(`unmapped regions (update this script):\n  ${problems.join("\n  ")}`);
  }

  const output = {
    generatedBy: "scripts/generate-aws-regions.mjs",
    sources: {
      endpoints: ENDPOINTS_URL,
      endpoints_sha256: createHash("sha256").update(raw).digest("hex"),
      names: "region descriptions in the endpoints file; cross-checked against https://docs.aws.amazon.com/general/latest/gr/rande.html",
    },
    probe: {
      template: PROBE_TEMPLATE,
      note: "GET / on the regional DynamoDB endpoint answers 200 with a tiny text health body and no redirect; it is the fastest uniform public target per region.",
    },
    groups: GROUPS,
    regions,
  };

  await writeFile(path.resolve(OUT_FILE), JSON.stringify(output, null, 2) + "\n");
  console.error(
    `Wrote ${OUT_FILE}: ${regions.length} regions across ${GROUPS.length} groups` +
      (EXCLUDED_REGIONS.size > 0 ? ` (excluded: ${[...EXCLUDED_REGIONS].join(", ")})` : ""),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
