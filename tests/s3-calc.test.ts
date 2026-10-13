/**
 * Tests for the S3 cost model (public/s3/s3-calc.js) against the real
 * generated dataset. Expected values are derived from the AWS price list
 * entries quoted in scripts/generate-s3-pricing.mjs.
 */

import { describe, expect, it } from "vitest";

import pricing from "../public/data/s3-pricing.json";
import { computeS3Cost, tieredStorageCost } from "../public/s3/s3-calc.js";

type S3Inputs = Parameters<typeof computeS3Cost>[1];
type S3Result = {
  ok: true;
  region: string;
  storage: { lines: Array<{ key: string; gb: number; cost: number }>; total: number };
  requests: { lines: Array<{ classId: string; cost: number }>; total: number };
  retrieval: { lines: Array<{ classId: string; mode: string; cost: number }>; total: number };
  transitions: { lines: Array<{ classId: string; cost: number }>; total: number };
  monitoring: { objectsPerMonth: number; cost: number };
  total: number;
  perTb: number | null;
  notes: string[];
};

const baseInputs: S3Inputs = {
  region: "us-east-1",
  storageGb: {},
  requests: {},
  itObjectsPerMonth: 0,
  retrieval: {},
  transitions: {},
};

/** Runs the model, failing the test if it did not succeed. */
const run = (override: Partial<S3Inputs> = {}): S3Result => {
  const result = computeS3Cost(pricing, { ...baseInputs, ...override }) as unknown as
    | S3Result
    | { ok: false; error: string };
  if (!result.ok) throw new Error(`simulation failed: ${result.error}`);
  return result;
};

describe("tieredStorageCost", () => {
  const tiers = [
    { upToGb: 51200, perGbMonth: 0.023 },
    { upToGb: 512000, perGbMonth: 0.022 },
    { upToGb: null, perGbMonth: 0.021 },
  ];

  it("bills the first tier only below its boundary", () => {
    expect(tieredStorageCost(1000, tiers)).toBeCloseTo(23);
    expect(tieredStorageCost(51200, tiers)).toBeCloseTo(51200 * 0.023);
  });

  it("spans tier boundaries", () => {
    // 51200 * 0.023 + 8800 * 0.022
    expect(tieredStorageCost(60000, tiers)).toBeCloseTo(1371.2);
  });

  it("bills the over-500TB tier beyond the boundary", () => {
    expect(tieredStorageCost(512000 + 1000, tiers)).toBeCloseTo(
      51200 * 0.023 + 460800 * 0.022 + 1000 * 0.021,
    );
  });

  it("treats negative volumes as zero", () => {
    expect(tieredStorageCost(-5, tiers)).toBe(0);
  });
});

describe("computeS3Cost", () => {
  it("rejects unknown regions", () => {
    const result = computeS3Cost(pricing, { ...baseInputs, region: "atlantis-1" });
    expect(result.ok).toBe(false);
  });

  it("prices standard storage at the published rate", () => {
    const result = run({ storageGb: { standard: 1000 } });
    expect(result.storage.total).toBeCloseTo(23);
    expect(result.total).toBeCloseTo(23);
  });

  it("prices each class at its own rate", () => {
    const result = run({
      storageGb: {
        standard: 1000, // 23
        "standard-ia": 1000, // 12.5
        "onezone-ia": 1000, // 10
        "glacier-ir": 1000, // 4
        "glacier-flexible": 1000, // 3.6
        "glacier-deep-archive": 1000, // 0.99
      },
    });
    expect(result.storage.total).toBeCloseTo(23 + 12.5 + 10 + 4 + 3.6 + 0.99);
  });

  it("prices Intelligent-Tiering access tiers and monitoring", () => {
    const result = run({
      storageGb: {
        "it-frequent": 1000, // 23
        "it-infrequent": 2000, // 25
        "it-archive-instant": 1000, // 4
        "it-archive": 1000, // 3.6
        "it-deep-archive": 1000, // 0.99
      },
      itObjectsPerMonth: 1_000_000, // 1000 * 0.0025 = 2.5
    });
    expect(result.storage.total).toBeCloseTo(23 + 25 + 4 + 3.6 + 0.99);
    expect(result.monitoring.cost).toBeCloseTo(2.5);
    expect(result.total).toBeCloseTo(23 + 25 + 4 + 3.6 + 0.99 + 2.5);
  });

  it("prices requests per class per 1,000", () => {
    const result = run({
      requests: {
        standard: { put: 100_000, get: 1_000_000 }, // 0.5 + 0.4
        "standard-ia": { put: 10_000, get: 100_000 }, // 0.1 + 0.1
      },
    });
    expect(result.requests.total).toBeCloseTo(1.1);
  });

  it("prices retrieval per class and mode", () => {
    const standard = run({ retrieval: { "glacier-flexible": { gb: 100, mode: "standard" } } });
    expect(standard.retrieval.total).toBeCloseTo(1); // 0.01/GB
    const bulk = run({ retrieval: { "glacier-flexible": { gb: 100, mode: "bulk" } } });
    expect(bulk.retrieval.total).toBeCloseTo(0); // bulk retrieval is free in the current price list
    const expedited = run({ retrieval: { "glacier-flexible": { gb: 100, mode: "expedited" } } });
    expect(expedited.retrieval.total).toBeCloseTo(3); // 0.03/GB
    const gdaBulk = run({ retrieval: { "glacier-deep-archive": { gb: 1000, mode: "bulk" } } });
    expect(gdaBulk.retrieval.total).toBeCloseTo(2.5); // 0.0025/GB
  });

  it("falls back to standard retrieval when the mode is not offered", () => {
    const result = run({
      retrieval: { "standard-ia": { gb: 100, mode: "expedited" } },
    });
    expect(result.retrieval.lines[0].mode).toBe("standard");
    expect(result.retrieval.total).toBeCloseTo(1);
  });

  it("prices lifecycle transitions into each class", () => {
    const result = run({
      transitions: {
        "standard-ia": 5000, // 5 * 0.01
        "glacier-ir": 1000, // 1 * 0.02
        "glacier-deep-archive": 1000, // 1 * 0.05
      },
    });
    expect(result.transitions.total).toBeCloseTo(0.05 + 0.02 + 0.05);
  });

  it("ignores zero and junk inputs", () => {
    const result = run({
      storageGb: { standard: Number.NaN, "glacier-ir": -5 },
      requests: { standard: { put: -100, get: 0 } },
    });
    expect(result.storage.total).toBe(0);
    expect(result.requests.total).toBe(0);
    expect(result.total).toBe(0);
  });

  it("surfaces restore-request, IT-retrieval, and early-delete notes", () => {
    const result = run({
      storageGb: { "glacier-deep-archive": 1000, "it-frequent": 100 },
      transitions: { "standard-ia": 100 },
      itObjectsPerMonth: 1000,
    });
    const notes = result.notes.join(" ");
    expect(notes).toContain("restore requests");
    expect(notes).toContain("Intelligent-Tiering retrieval");
    expect(notes).toContain("early-deletion fees");
  });

  it("reports the full cost and an effective per-TB rate", () => {
    const result = run({ storageGb: { standard: 1024 } });
    expect(result.total).toBeCloseTo(1024 * 0.023); // 23.552
    expect(result.perTb).toBeCloseTo(1024 * 0.023, 1);
  });
});
