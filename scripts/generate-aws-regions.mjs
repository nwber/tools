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
    if (description && group && dynamodbRegions.has(code)) {
      regions.push({ code, name: description, group });
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
