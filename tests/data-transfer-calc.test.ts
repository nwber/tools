/**
 * Tests for the data transfer cost model (public/data-transfer/data-transfer-calc.js)
 * against the real generated dataset. Expected values are derived from the
 * price list entries quoted in scripts/generate-data-transfer-pricing.mjs.
 */

import { describe, expect, it } from "vitest";

import pricing from "../public/data/data-transfer-pricing.json";
import {
  computeDataTransferCost,
  tieredCost,
} from "../public/data-transfer/data-transfer-calc.js";

type Inputs = Parameters<typeof computeDataTransferCost>[1];
type Line = { key: string; label: string; usd: number; gb?: number; unpriced?: boolean };
type Result = {
  ok: true;
  region: string;
  azCount: number;
  scenarios: { nat: { lines: Line[]; total: number }; endpoints: { lines: Line[]; total: number } };
  savings: number;
  savingsPerYear: number;
  internet: { gb: number; freeGb: number; billableGb: number; cost: number };
  breakEven: {
    perServiceGb: number | null;
    combinedGb: number | null;
    servicesGb: number;
    worthIt: boolean;
  } | null;
  rates: {
    natHourUsd: number;
    natGbUsd: number;
    endpointHourUsd: number;
    crossAzPerGb: number;
    interRegionOutPerGb: number | null;
  };
  notes: string[];
};

const emptyTraffic = {
  s3Gb: 0,
  dynamodbGb: 0,
  otherAwsGb: 0,
  internetGb: 0,
  crossAzGb: 0,
  crossRegionGb: 0,
};

const baseInputs: Inputs = {
  region: "us-east-1",
  azCount: 2,
  interfaceEndpointCount: 0,
  traffic: emptyTraffic,
  crossRegionDest: "eu-west-1",
};

/** Runs the model, failing the test if it did not succeed. */
const run = (override: Partial<Inputs> = {}): Result => {
  const result = computeDataTransferCost(pricing, {
    ...baseInputs,
    ...override,
    traffic: { ...emptyTraffic, ...(override.traffic ?? {}) },
  }) as unknown as Result | { ok: false; error: string };
  if (!result.ok) throw new Error(`estimate failed: ${result.error}`);
  return result;
};

const lineOf = (scenario: { lines: Line[] }, key: string): Line | undefined =>
  scenario.lines.find((line) => line.key === key);

describe("tieredCost", () => {
  const tiers = [
    { upToGb: 10240, perGbUsd: 0.09 },
    { upToGb: 51200, perGbUsd: 0.085 },
    { upToGb: null, perGbUsd: 0.05 },
  ];

  it("bills only the first tier below its boundary", () => {
    expect(tieredCost(1000, tiers)).toBeCloseTo(90);
    expect(tieredCost(10240, tiers)).toBeCloseTo(10240 * 0.09);
  });

  it("spans tier boundaries", () => {
    expect(tieredCost(11240, tiers)).toBeCloseTo(10240 * 0.09 + 1000 * 0.085);
    // 61240 GB: 10240 @ 0.09 + (51200-10240) @ 0.085 + (61240-51200) @ 0.05
    expect(tieredCost(61240, tiers)).toBeCloseTo(
      10240 * 0.09 + 40960 * 0.085 + 10040 * 0.05,
    );
  });

  it("treats negative volumes as zero", () => {
    expect(tieredCost(-5, tiers)).toBe(0);
  });
});

describe("computeDataTransferCost", () => {
  it("rejects unknown regions", () => {
    const result = computeDataTransferCost(pricing, {
      ...baseInputs,
      region: "atlantis-1",
    });
    expect(result.ok).toBe(false);
  });

  it("prices NAT gateway hours per AZ and per month", () => {
    const result = run({ azCount: 2 });
    // 2 AZs x 730 h x $0.045
    expect(lineOf(result.scenarios.nat, "nat-hours")?.usd).toBeCloseTo(65.7);
    expect(lineOf(result.scenarios.endpoints, "nat-hours")?.usd).toBeCloseTo(65.7);
    expect(result.scenarios.nat.total).toBeCloseTo(65.7);
  });

  it("processes S3, DynamoDB, other AWS and internet traffic through NAT", () => {
    const result = run({
      traffic: { s3Gb: 1000, dynamodbGb: 500, otherAwsGb: 500, internetGb: 1000 },
    });
    // (1000 + 500 + 500 + 1000) GB x $0.045; internet egress: 900 billable x $0.09
    expect(lineOf(result.scenarios.nat, "nat-processing")?.usd).toBeCloseTo(135);
    expect(lineOf(result.scenarios.endpoints, "nat-processing")?.usd).toBeCloseTo(45);
    expect(result.internet.freeGb).toBe(100);
    expect(result.internet.billableGb).toBe(900);
    expect(result.internet.cost).toBeCloseTo(81);
  });

  it("applies the 100 GB global free tier before the tiered rates", () => {
    const result = run({ traffic: { internetGb: 10300 } });
    // billable 10200: 10200 x 0.09 (still in the first tier)
    expect(result.internet.cost).toBeCloseTo(10200 * 0.09);
    const big = run({ traffic: { internetGb: 11500 } });
    // billable 11400: 10240 x 0.09 + 1160 x 0.085
    expect(big.internet.cost).toBeCloseTo(10240 * 0.09 + 1160 * 0.085);
  });

  it("makes S3 and DynamoDB gateway endpoints free savings", () => {
    const result = run({ traffic: { s3Gb: 2000, dynamodbGb: 1000 } });
    expect(result.scenarios.nat.total).toBeCloseTo(65.7 + 135);
    expect(result.scenarios.endpoints.total).toBeCloseTo(65.7);
    expect(result.savings).toBeCloseTo(135);
    expect(result.notes.join(" ")).toContain("gateway endpoints are free");
  });

  it("prices interface endpoints per service per AZ plus processing", () => {
    const result = run({
      interfaceEndpointCount: 2,
      traffic: { otherAwsGb: 1000 },
    });
    // 2 endpoints x 2 AZs x 730 h x $0.01; processing 1000 GB x $0.01
    expect(lineOf(result.scenarios.endpoints, "endpoint-hours")?.usd).toBeCloseTo(29.2);
    expect(lineOf(result.scenarios.endpoints, "endpoint-processing")?.usd).toBeCloseTo(10);
    // baseline: 1000 GB x $0.045 processing
    expect(lineOf(result.scenarios.nat, "nat-processing")?.usd).toBeCloseTo(45);
    expect(result.savings).toBeCloseTo(45 - 39.2);
  });

  it("computes the interface endpoint break-even per service", () => {
    const result = run({ interfaceEndpointCount: 1, traffic: { otherAwsGb: 1000 } });
    expect(result.breakEven).not.toBeNull();
    // 2 AZs x 730 h x $0.01 / ($0.045 - $0.01) = 417.14 GB
    expect(result.breakEven?.perServiceGb).toBeCloseTo(417.14, 1);
    expect(result.breakEven?.worthIt).toBe(true);
    expect(result.notes.join(" ")).toContain("pay off");
  });

  it("scales the break-even with the number of endpoints", () => {
    // Three endpoints: combined break-even 3 x 417.14 = 1251.43 GB.
    const result = run({ interfaceEndpointCount: 3, traffic: { otherAwsGb: 1000 } });
    expect(result.breakEven?.combinedGb).toBeCloseTo(1251.43, 1);
    expect(result.breakEven?.worthIt).toBe(false);
  });

  it("flags interface endpoints that do not pay off at low volume", () => {
    const result = run({ interfaceEndpointCount: 1, traffic: { otherAwsGb: 100 } });
    expect(result.breakEven?.worthIt).toBe(false);
    expect(result.notes.join(" ")).toContain("do not pay off");
  });

  it("bills cross-AZ traffic in both directions and cross-region outbound only", () => {
    const result = run({ traffic: { crossAzGb: 500, crossRegionGb: 200 } });
    // 500 GB x 2 directions x $0.01; 200 GB x $0.02 (us-east-1 -> eu-west-1)
    expect(lineOf(result.scenarios.nat, "cross-az")?.usd).toBeCloseTo(10);
    expect(lineOf(result.scenarios.nat, "cross-region")?.usd).toBeCloseTo(4);
    // unchanged by endpoints
    expect(lineOf(result.scenarios.endpoints, "cross-az")?.usd).toBeCloseTo(10);
    expect(lineOf(result.scenarios.endpoints, "cross-region")?.usd).toBeCloseTo(4);
  });

  it("rejects an invalid cross-region destination when that traffic exists", () => {
    const missing = computeDataTransferCost(pricing, {
      ...baseInputs,
      crossRegionDest: "atlantis-1",
      traffic: { ...emptyTraffic, crossRegionGb: 10 },
    });
    expect(missing.ok).toBe(false);
    const same = computeDataTransferCost(pricing, {
      ...baseInputs,
      crossRegionDest: "us-east-1",
      traffic: { ...emptyTraffic, crossRegionGb: 10 },
    });
    expect(same.ok).toBe(false);
    // Without cross-region traffic the destination is never consulted.
    expect(run({ crossRegionDest: "atlantis-1" }).ok).toBe(true);
  });

  it("flags inter-region pairs with no published rate instead of pricing them", () => {
    // The offer has no outbound Jakarta -> Sao Paulo pair (see missingPairs).
    const result = run({
      region: "ap-southeast-3",
      crossRegionDest: "sa-east-1",
      traffic: { crossRegionGb: 100 },
    });
    const line = lineOf(result.scenarios.nat, "cross-region");
    expect(line?.unpriced).toBe(true);
    expect(line?.usd).toBe(0);
    expect(result.rates.interRegionOutPerGb).toBeNull();
    expect(result.notes.join(" ")).toContain("no inter-region outbound rate");
  });

  it("clamps the AZ count and ignores junk volumes", () => {
    expect(run({ azCount: 0 }).azCount).toBe(1);
    expect(run({ azCount: 9 }).azCount).toBe(3);
    const result = run({
      traffic: {
        s3Gb: Number.NaN,
        dynamodbGb: -5,
        otherAwsGb: 0,
        internetGb: 0,
      },
    });
    expect(result.scenarios.nat.total).toBeCloseTo(65.7);
  });

  it("report positive savings per year and negative savings when endpoints add cost", () => {
    const good = run({ interfaceEndpointCount: 1, traffic: { otherAwsGb: 10_000 } });
    expect(good.savings).toBeGreaterThan(0);
    expect(good.savingsPerYear).toBeCloseTo(good.savings * 12);

    const bad = run({ interfaceEndpointCount: 3, traffic: { otherAwsGb: 10 } });
    expect(bad.savings).toBeLessThan(0);
    expect(bad.savingsPerYear).toBeLessThan(0);
  });

  it("surfaces the region's rates in the result", () => {
    const result = run({ traffic: { crossRegionGb: 1 } });
    expect(result.rates.natHourUsd).toBeCloseTo(0.045);
    expect(result.rates.natGbUsd).toBeCloseTo(0.045);
    expect(result.rates.endpointHourUsd).toBeCloseTo(0.01);
    expect(result.rates.crossAzPerGb).toBeCloseTo(0.01);
    expect(result.rates.interRegionOutPerGb).toBeCloseTo(0.02);
  });
});
