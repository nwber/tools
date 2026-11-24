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
import { calculateRows, calculateSeries } from "../public/ebs/ebs-calc.js";

const inputs = (overrides: Partial<Parameters<typeof calculateRows>[1]>) => ({
  region: "us-east-1",
  size: 100,
  unit: "GB" as const,
  iops: 3000,
  throughput: 125,
  selectedTypes: ["gp3"],
  ...overrides,
});

const graphInputs = (overrides: Partial<Parameters<typeof calculateSeries>[1]>) => ({
  ...inputs({}),
  axis: "iops" as "iops" | "throughput" | "size",
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

describe("calculateSeries (cost graph curves)", () => {
  it("sweeps gp3 IOPS to the 1.5x cap, flat to its baseline then at the provisioned rate", () => {
    // 3,000 IOPS in the calculator -> X domain 0..4,500.
    const { series, limit } = calculateSeries(pricing, graphInputs({ selectedTypes: ["gp3"] }));
    expect(limit).toBe(4500);
    // The cost is piecewise linear, so vertices alone are exact.
    expect(series[0]?.points.map((p) => p.x)).toEqual([0, 3000, 4500]);
    // 100 GiB at $0.08/GiB with throughput held at its baseline.
    expect(series[0]?.points[0]?.y).toBeCloseTo(8);
    expect(series[0]?.points[1]?.y).toBeCloseTo(8);
    expect(series[0]?.points[2]?.y).toBeCloseTo(8 + (4500 - 3000) * 0.005);
  });

  it("caps a 5,000-IOPS configuration at 7,500", () => {
    const { series, limit } = calculateSeries(
      pricing,
      graphInputs({ iops: 5000, selectedTypes: ["gp3", "io2"] }),
    );
    expect(limit).toBe(7500);
    expect(series[0]?.points.map((p) => p.x)).toEqual([0, 3000, 7500]);
    expect(series[1]?.points.map((p) => p.x)).toEqual([0, 50, 7500]);
  });

  it("still ends a type early at its own limit when the cap is beyond it", () => {
    // st1 tops out at 500 IOPS, well below the 4,500 cap.
    const { series } = calculateSeries(pricing, graphInputs({ selectedTypes: ["st1"] }));
    const points = series[0]?.points ?? [];
    expect(points.map((p) => p.x)).toEqual([0, 500]);
    expect(points.map((p) => p.y)).toEqual([4.5, 4.5]);
  });

  it("falls back to each type's full range when the swept input is 0", () => {
    const { series, limit } = calculateSeries(
      pricing,
      graphInputs({ iops: 0, selectedTypes: ["gp3", "io2"] }),
    );
    expect(limit).toBe(256000);
    expect(series[0]?.points.map((p) => p.x)).toEqual([0, 3000, 16000]);
    expect(series[1]?.points.map((p) => p.x)).toEqual([0, 50, 256000]);
  });

  it("starts io1's provisioned-IOPS slope at its baseline of 50", () => {
    const { series } = calculateSeries(pricing, graphInputs({ selectedTypes: ["io1"] }));
    const points = series[0]?.points ?? [];
    expect(points.map((p) => p.x)).toEqual([0, 50, 4500]);
    expect(points[1]?.y).toBeCloseTo(12.5); // 100 GiB at $0.125/GiB, at baseline
    expect(points[2]?.y).toBeCloseTo(12.5 + (4500 - 50) * 0.065);
  });

  it("sweeps gp3 throughput at the provisioned rate past its baseline to the cap", () => {
    const { series, limit } = calculateSeries(
      pricing,
      graphInputs({ selectedTypes: ["gp3"], axis: "throughput" }),
    );
    // 125 MiB/s in the calculator -> X domain 0..187.5.
    expect(limit).toBe(187.5);
    const points = series[0]?.points ?? [];
    expect(points.map((p) => p.x)).toEqual([0, 125, 187.5]);
    expect(points[0]?.y).toBeCloseTo(8);
    expect(points[2]?.y).toBeCloseTo(8 + (187.5 - 125) * 0.04);
  });

  it("sweeps size linearly from $0 at 0 GiB to the cap", () => {
    const { series, limit } = calculateSeries(
      pricing,
      graphInputs({ selectedTypes: ["gp3"], axis: "size" }),
    );
    // 100 GiB in the calculator -> X domain 0..150.
    expect(limit).toBe(150);
    const points = series[0]?.points ?? [];
    expect(points.map((p) => p.x)).toEqual([0, 150]);
    expect(points[0]?.y).toBe(0);
    expect(points[1]?.y).toBeCloseTo(150 * 0.08);
  });

  it("returns an empty curve when held inputs already exceed a type's limits", () => {
    // st1 tops out at 500 IOPS; holding 3000 IOPS leaves no valid size.
    const { series } = calculateSeries(
      pricing,
      graphInputs({ selectedTypes: ["st1"], axis: "size" }),
    );
    expect(series).toHaveLength(1);
    expect(series[0]?.points).toEqual([]);
  });

  it("keeps declaration order and carries the display name", () => {
    const { series } = calculateSeries(
      pricing,
      graphInputs({ selectedTypes: ["io2", "gp3"], axis: "size" }),
    );
    expect(series.map((s) => s.type)).toEqual(["gp3", "io2"]);
    expect(series[0]?.name).toBe("General Purpose SSD (gp3)");
  });

  it("uses the region's rates for the swept curve", () => {
    const { series } = calculateSeries(
      pricing,
      graphInputs({ region: "sa-east-1", axis: "size" }),
    );
    expect(series[0]?.points[1]?.y).toBeCloseTo(150 * 0.1);
  });

  it("holds TiB sizes at their GiB equivalent on the IOPS axis", () => {
    const { series } = calculateSeries(
      pricing,
      graphInputs({ size: 1, unit: "TB" as const }),
    );
    expect(series[0]?.points[0]?.y).toBeCloseTo(1024 * 0.08);
  });
});
