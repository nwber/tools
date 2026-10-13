import { describe, expect, it } from "vitest";

import {
  EBS_REGIONS,
  EBS_VOLUME_TYPES,
  computeEbsMatrix,
  ebsLineItem,
  parseEbsInputs,
  type EbsInputs,
} from "../src/tools/ebs-pricing.ts";

const inputsOrThrow = (values: Record<string, unknown>): EbsInputs => {
  const parsed = parseEbsInputs(values);
  if (!parsed.ok) throw new Error(`unexpected parse error: ${parsed.error}`);
  return parsed.inputs;
};

describe("parseEbsInputs", () => {
  it("applies defaults", () => {
    const inputs = inputsOrThrow({});
    expect(inputs.sizeGb).toBe(100);
    expect(inputs.iops).toBeUndefined();
    expect(inputs.throughputMbps).toBeUndefined();
    expect(inputs.regions).toEqual([...EBS_REGIONS]);
  });

  it("accepts string values from query params", () => {
    const inputs = inputsOrThrow({
      size_gb: "512",
      iops: "5000",
      throughput_mbps: "300",
      regions: "us-east-1, eu-west-1",
    });
    expect(inputs.sizeGb).toBe(512);
    expect(inputs.iops).toBe(5000);
    expect(inputs.throughputMbps).toBe(300);
    expect(inputs.regions).toEqual(["us-east-1", "eu-west-1"]);
  });

  it("accepts numbers and lists from a JSON body", () => {
    const inputs = inputsOrThrow({ size_gb: 2048, iops: 12000, regions: ["eu-west-1"] });
    expect(inputs.sizeGb).toBe(2048);
    expect(inputs.iops).toBe(12000);
    expect(inputs.regions).toEqual(["eu-west-1"]);
  });

  it("rejects out-of-bounds and malformed numbers", () => {
    for (const bad of ["0", "16385", "abc", "-5", 100.5, "100.5", ""]) {
      const parsed = parseEbsInputs({ size_gb: bad });
      expect(parsed.ok, `size_gb=${JSON.stringify(bad)}`).toBe(false);
    }
    expect(parseEbsInputs({ iops: "-1" }).ok).toBe(false);
    expect(parseEbsInputs({ throughput_mbps: "4001" }).ok).toBe(false);
  });

  it("rejects unknown regions with a helpful message", () => {
    const parsed = parseEbsInputs({ regions: "us-east-1,mars-central-1" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("mars-central-1");
  });

  it("rejects empty region selections", () => {
    const parsed = parseEbsInputs({ regions: "  " });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("cannot be empty");
  });
});

describe("ebsLineItem", () => {
  it("prices gp2 storage only", () => {
    expect(ebsLineItem("gp2", "us-east-1", 100)).toEqual({
      storage_usd: 10,
      iops_usd: 0,
      throughput_usd: 0,
      total_usd: 10,
    });
  });

  it("charges gp3 only for extras beyond the allowances", () => {
    const item = ebsLineItem("gp3", "us-east-1", 100, 5000, 300);
    expect(item.storage_usd).toBeCloseTo(8);
    expect(item.iops_usd).toBeCloseTo((5000 - 3000) * 0.005);
    expect(item.throughput_usd).toBeCloseTo((300 - 125) * 0.04);
    expect(item.total_usd).toBeCloseTo(25);
  });

  it("bills nothing extra for gp3 within the allowances", () => {
    const item = ebsLineItem("gp3", "us-east-1", 100, 3000, 125);
    expect(item.iops_usd).toBe(0);
    expect(item.throughput_usd).toBe(0);
    expect(item.total_usd).toBeCloseTo(8);
  });

  it("bills every provisioned IOPS on io1", () => {
    const item = ebsLineItem("io1", "us-east-1", 100, 3000);
    expect(item.storage_usd).toBeCloseTo(12.5);
    expect(item.iops_usd).toBeCloseTo(3000 * 0.065);
    expect(item.total_usd).toBeCloseTo(12.5 + 195);
  });

  it("uses the lower storage rate on io2", () => {
    expect(ebsLineItem("io2", "us-east-1", 100).storage_usd).toBeCloseTo(6.5);
  });

  it("notes unsupported inputs for storage-only types", () => {
    const item = ebsLineItem("sc1", "us-east-1", 100, 3000);
    expect(item.note).toBe("provisioned iops/throughput not supported for this volume type");
    expect(item.iops_usd).toBe(0);
    expect(item.total_usd).toBeCloseTo(1.5);
  });

  it("applies the region multiplier", () => {
    expect(ebsLineItem("gp2", "sa-east-1", 100).total_usd).toBeCloseTo(10 * 1.25);
  });
});

describe("computeEbsMatrix", () => {
  it("covers every volume type and region", () => {
    const result = computeEbsMatrix(inputsOrThrow({}));
    expect(result.lineItems).toBe(EBS_VOLUME_TYPES.length * EBS_REGIONS.length);
    for (const volumeType of EBS_VOLUME_TYPES) {
      expect(Object.keys(result.matrix[volumeType]).sort()).toEqual([...EBS_REGIONS].sort());
    }
  });

  it("totals match the matrix", () => {
    const result = computeEbsMatrix(inputsOrThrow({}));
    let expected = 0;
    for (const perRegion of Object.values(result.matrix)) {
      for (const item of Object.values(perRegion)) {
        expected += item.total_usd;
      }
    }
    expect(result.totals.grand_usd).toBeCloseTo(expected, 4);
  });

  it("supports region subsets", () => {
    const result = computeEbsMatrix(inputsOrThrow({ regions: "us-east-1,eu-west-1" }));
    expect(result.lineItems).toBe(EBS_VOLUME_TYPES.length * 2);
  });

  it("flows IOPS inputs through every type", () => {
    const result = computeEbsMatrix(inputsOrThrow({ regions: "us-east-1", iops: "10000" }));
    expect(result.matrix.gp3["us-east-1"]?.iops_usd).toBeCloseTo((10000 - 3000) * 0.005);
    expect(result.matrix.io1["us-east-1"]?.iops_usd).toBeCloseTo(10000 * 0.065);
  });
});
