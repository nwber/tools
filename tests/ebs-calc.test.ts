/**
 * Tests for the ported client-side pricing math against the real recovered
 * dataset (public/data/ebs-pricing.json).
 *
 * The expectations mirror the behavior of the original tool
 * (ebs-pricing-comparator.nwber.workers.dev) exactly — including quirks like
 * gp2's provisionedIOPS field, which the original data carries even though
 * AWS does not bill gp2 that way. A faithful port keeps them.
 */

import { describe, expect, it } from "vitest";

import pricing from "../public/data/ebs-pricing.json";
import { calculateRows } from "../public/ebs/ebs-calc.js";

const inputs = (overrides: Partial<Parameters<typeof calculateRows>[1]>) => ({
  region: "us-east-1",
  size: 100,
  unit: "GB" as const,
  iops: 3000,
  throughput: 125,
  selectedTypes: ["gp3"],
  ...overrides,
});

describe("calculateRows (recovered tool math)", () => {
  it("prices gp3 within its baselines as storage only", () => {
    const { rows, warnings } = calculateRows(pricing, inputs({}));
    expect(warnings).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "gp3",
      error: false,
      meets: true,
      storage: 8,
      iopsCost: 0,
      throughputCost: 0,
      total: 8,
    });
  });

  it("charges gp3 only for IOPS and throughput above baseline", () => {
    const { rows } = calculateRows(pricing, inputs({ iops: 5000, throughput: 300 }));
    expect(rows[0]?.iopsCost).toBeCloseTo((5000 - 3000) * 0.005);
    expect(rows[0]?.throughputCost).toBeCloseTo((300 - 125) * 0.04);
    expect(rows[0]?.total).toBeCloseTo(8 + 10 + 7);
  });

  it("charges gp2 IOPS above baseline per the recovered data", () => {
    const { rows } = calculateRows(pricing, inputs({ selectedTypes: ["gp2"], iops: 5000 }));
    expect(rows[0]?.storage).toBeCloseTo(10);
    expect(rows[0]?.iopsCost).toBeCloseTo((5000 - 3000) * 0.005);
    expect(rows[0]?.total).toBeCloseTo(20);
  });

  it("bills io1 every provisioned IOPS above its baseline of 50", () => {
    const { rows } = calculateRows(pricing, inputs({ selectedTypes: ["io1"], iops: 3000 }));
    expect(rows[0]?.storage).toBeCloseTo(12.5);
    expect(rows[0]?.iopsCost).toBeCloseTo((3000 - 50) * 0.065);
  });

  it("does not bill IOPS for st1 (no provisionedIOPS in the data)", () => {
    const { rows, warnings } = calculateRows(
      pricing,
      inputs({ selectedTypes: ["st1"], iops: 500, throughput: 250 }),
    );
    expect(warnings).toEqual([]);
    expect(rows[0]?.storage).toBeCloseTo(4.5);
    expect(rows[0]?.iopsCost).toBe(0);
    expect(rows[0]?.throughputCost).toBe(0);
  });

  it("converts TiB to GiB like the original", () => {
    const { rows } = calculateRows(pricing, inputs({ size: 1, unit: "TB" }));
    expect(rows[0]?.storage).toBeCloseTo(1024 * 0.08);
  });

  it("flags size, IOPS, and throughput limits with the original wording", () => {
    const { rows, warnings } = calculateRows(
      pricing,
      inputs({ size: 20000, iops: 20000, throughput: 2000 }),
    );
    expect(rows[0]?.error).toBe(true);
    expect(rows[0]?.meets).toBe(false);
    expect(rows[0]?.total).toBeNull();
    expect(warnings).toEqual([
      "General Purpose SSD (gp3) exceeds max size of 16384GiB",
      "General Purpose SSD (gp3) exceeds max IOPS of 16000",
      "General Purpose SSD (gp3) exceeds max throughput of 1000MiB/s",
    ]);
  });

  it("skips unselected types and keeps declaration order", () => {
    const { rows } = calculateRows(
      pricing,
      inputs({ selectedTypes: ["io2", "gp3", "standard"], iops: 3000 }),
    );
    expect(rows.map((row) => row.type)).toEqual(["gp3", "io2", "standard"]);
  });

  it("uses the region's prices", () => {
    const { rows } = calculateRows(
      pricing,
      inputs({ region: "sa-east-1", selectedTypes: ["gp3"] }),
    );
    expect(rows[0]?.storage).toBeCloseTo(100 * 0.1);
  });
});
