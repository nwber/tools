#!/usr/bin/env node
/**
 * Generates public/data/world-outline.json — the country outlines the
 * /aws-latency/ map draws as its background (public/aws-latency/
 * aws-latency-map-calc.js decodes the TopoJSON in the browser).
 *
 * Usage:
 *   node scripts/generate-world-outline.mjs [--input <countries-110m.json>]
 *
 * Source:
 *   https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json
 *     Natural Earth 1:110m Admin-0 countries as TopoJSON (quantized, ~105
 *     KiB) from the world-atlas package. Natural Earth data is public
 *     domain; the 110m resolution is the right visual density for a
 *     whole-world view that can still be zoomed to a country.
 *
 * The topology is stored as-is (arcs still quantized and delta-encoded —
 * a flat GeoJSON would be ~5x larger) and decoded client-side by a pure,
 * unit-tested function.
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const OUTLINE_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";
const OUT_FILE = "public/data/world-outline.json";

/** Minimal shape check so a bad download fails loudly instead of at page load. */
function validateTopology(topology) {
  const problems = [];
  if (topology?.type !== "Topology") problems.push("type is not Topology");
  if (!Array.isArray(topology?.transform?.scale) || topology.transform.scale.length !== 2) {
    problems.push("no 2-element transform.scale");
  }
  if (!Array.isArray(topology?.transform?.translate) || topology.transform.translate.length !== 2) {
    problems.push("no 2-element transform.translate");
  }
  if (!Array.isArray(topology?.arcs) || topology.arcs.length === 0) {
    problems.push("no arcs");
  }
  const geometries = topology?.objects?.countries?.geometries;
  if (!Array.isArray(geometries) || geometries.length < 100) {
    problems.push(`objects.countries.geometries missing or implausibly small: ${geometries?.length}`);
  }
  for (const [index, geometry] of (geometries ?? []).entries()) {
    if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") {
      problems.push(`geometry ${index} (${geometry.id ?? "?"}) is a ${geometry.type}, not a (Multi)Polygon`);
      if (problems.length > 5) break;
    }
  }
  if (problems.length > 0) throw new Error(`not a usable world-atlas topology:\n  ${problems.join("\n  ")}`);
}

async function main() {
  const inputIndex = process.argv.indexOf("--input");
  let raw;
  if (inputIndex !== -1) {
    const inputPath = process.argv[inputIndex + 1];
    if (!inputPath) throw new Error("--input needs a path");
    console.error(`Reading outline file from ${inputPath}`);
    raw = await readFile(inputPath, "utf8");
  } else {
    console.error(`Downloading ${OUTLINE_URL}...`);
    const response = await fetch(OUTLINE_URL);
    if (!response.ok) throw new Error(`outline download failed: ${response.status}`);
    raw = await response.text();
  }

  const topology = JSON.parse(raw);
  validateTopology(topology);

  const output = {
    generatedBy: "scripts/generate-world-outline.mjs",
    sources: {
      outline: OUTLINE_URL,
      outline_sha256: createHash("sha256").update(raw).digest("hex"),
      license: "Natural Earth (public domain), packaged as TopoJSON by world-atlas",
      note: "Admin-0 countries at 1:110m; stored as-is (quantized, delta-encoded) and decoded client-side by public/aws-latency/aws-latency-map-calc.js.",
    },
    topology,
  };

  await writeFile(path.resolve(OUT_FILE), JSON.stringify(output) + "\n");
  console.error(
    `Wrote ${OUT_FILE}: ${topology.objects.countries.geometries.length} countries, ` +
      `${topology.arcs.length} arcs, ${(Buffer.byteLength(raw) / 1024).toFixed(1)} KiB of topology`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
