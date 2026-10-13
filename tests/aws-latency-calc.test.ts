/**
 * Tests for the AWS region latency tool: the pure math/URL helpers
 * (public/aws-latency/aws-latency-calc.js) and the generated dataset.
 */

import { describe, expect, it } from "vitest";

import dataset from "../public/data/aws-regions.json";
import {
  jitter,
  median,
  min,
  probeUrl,
  sortByMedian,
  summarize,
} from "../public/aws-latency/aws-latency-calc.js";

describe("median", () => {
  it("handles odd and even counts", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("returns 0 for empty input", () => {
    expect(median([])).toBe(0);
  });
});

describe("min", () => {
  it("returns the smallest sample", () => {
    expect(min([9, 4, 7])).toBe(4);
    expect(min([])).toBe(0);
  });
});

describe("jitter", () => {
  it("averages the absolute successive differences", () => {
    // |10-12| + |14-10| + |11-14| = 2+4+3 = 9 / 3 = 3
    expect(jitter([12, 10, 14, 11])).toBe(3);
  });

  it("is 0 for fewer than two samples", () => {
    expect(jitter([5])).toBe(0);
    expect(jitter([])).toBe(0);
  });
});

describe("summarize", () => {
  it("rounds min/median/jitter to one decimal", () => {
    const summary = summarize([12.34, 10.16, 14.04, 11.11]);
    expect(summary.min).toBe(10.2);
    expect(summary.median).toBe(11.7);
    expect(summary.jitter).toBe(3); // (2.18 + 3.88 + 2.93) / 3
    expect(summary.samples).toBe(4);
  });
});

describe("probeUrl", () => {
  it("expands the {region} placeholder", () => {
    expect(probeUrl("https://dynamodb.{region}.amazonaws.com/", "us-east-1")).toBe(
      "https://dynamodb.us-east-1.amazonaws.com/",
    );
  });

  it("expands every occurrence", () => {
    expect(probeUrl("https://{region}.example.com/{region}", "eu-west-1")).toBe(
      "https://eu-west-1.example.com/eu-west-1",
    );
  });

  it("throws when the template has no placeholder", () => {
    expect(() => probeUrl("https://dynamodb.amazonaws.com/", "us-east-1")).toThrow(
      /placeholder/,
    );
  });
});

describe("sortByMedian", () => {
  const row = (value: number | null) => ({
    region: { name: `row-${value}` },
    summary: value === null ? null : { median: value },
  });

  it("orders measured rows by median ascending", () => {
    const sorted = sortByMedian([row(30), row(10), row(20)]);
    expect(sorted.map((r) => r.summary?.median)).toEqual([10, 20, 30]);
  });

  it("keeps unmeasured rows last in their input order", () => {
    const a = row(null);
    const b = row(null);
    const sorted = sortByMedian([a, row(5), b]);
    expect(sorted[0]?.summary?.median).toBe(5);
    expect(sorted[1]).toBe(a);
    expect(sorted[2]).toBe(b);
  });
});

describe("aws-regions dataset", () => {
  const regions = dataset.regions;

  it("covers the 34 commercial regions, sorted and unique", () => {
    expect(regions).toHaveLength(34);
    const codes = regions.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect([...codes].sort()).toEqual(codes);
  });

  it("has a display name and a known group for every region", () => {
    const groupIds = new Set(dataset.groups.map((g) => g.id));
    for (const region of regions) {
      expect(region.name, region.code).toBeTruthy();
      expect(groupIds.has(region.group), `${region.code}: ${region.group}`).toBe(true);
    }
  });

  it("carries a probe template that builds a per-region HTTPS URL", () => {
    expect(dataset.probe.template).toContain("{region}");
    expect(dataset.probe.note).toBeTruthy();
    for (const region of regions) {
      const url = new URL(probeUrl(dataset.probe.template, region.code));
      expect(url.protocol).toBe("https:");
      expect(url.host).toBe(`dynamodb.${region.code}.amazonaws.com`);
    }
  });

  it("matches the AWS docs names for a sample of regions", () => {
    const byCode = new Map(regions.map((r) => [r.code, r]));
    expect(byCode.get("us-east-1")?.name).toBe("US East (N. Virginia)");
    expect(byCode.get("ap-east-2")?.name).toBe("Asia Pacific (Taipei)");
    expect(byCode.get("mx-central-1")?.name).toBe("Mexico (Central)");
    expect(byCode.get("eu-south-2")?.name).toBe("Europe (Spain)");
  });

  it("groups regions as expected", () => {
    const byCode = new Map(regions.map((r) => [r.code, r]));
    expect(byCode.get("us-west-2")?.group).toBe("us-canada");
    expect(byCode.get("ca-west-1")?.group).toBe("us-canada");
    expect(byCode.get("sa-east-1")?.group).toBe("latin-america");
    expect(byCode.get("mx-central-1")?.group).toBe("latin-america");
    expect(byCode.get("eu-north-1")?.group).toBe("europe");
    expect(byCode.get("ap-southeast-6")?.group).toBe("asia-pacific");
    expect(byCode.get("me-central-1")?.group).toBe("middle-east-africa");
    expect(byCode.get("af-south-1")?.group).toBe("middle-east-africa");
    expect(byCode.get("il-central-1")?.group).toBe("middle-east-africa");
  });

  it("records the source endpoints hash for refreshes", () => {
    expect(dataset.sources.endpoints_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
