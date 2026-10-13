/**
 * Tests for the speed test measurement math (public/speedtest/speedtest-calc.js).
 */

import { describe, expect, it } from "vitest";

import { formatMbps, jitter, latencySummary, mbps, median, min } from "../public/speedtest/speedtest-calc.js";

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

describe("mbps", () => {
  it("converts bytes over milliseconds", () => {
    // 1 MB in 1 s = 8 Mbps
    expect(mbps(1_000_000, 1000)).toBeCloseTo(8);
    // 8 MiB in 500 ms = 134.2 Mbps
    expect(mbps(8 * 1024 * 1024, 500)).toBeCloseTo(134.2, 1);
  });

  it("returns 0 for degenerate input", () => {
    expect(mbps(0, 1000)).toBe(0);
    expect(mbps(1000, 0)).toBe(0);
  });
});

describe("formatMbps", () => {
  it("keeps one decimal below 100 and rounds above", () => {
    expect(formatMbps(9.87)).toBe("9.9");
    expect(formatMbps(123.4)).toBe("123");
  });
});

describe("latencySummary", () => {
  it("rounds min/median/jitter to one decimal", () => {
    const summary = latencySummary([12.34, 10.16, 14.04, 11.11]);
    expect(summary.min).toBe(10.2);
    expect(summary.median).toBe(11.7);
    expect(summary.jitter).toBe(3); // (2.18 + 3.88 + 2.93) / 3
    expect(summary.samples).toBe(4);
  });
});
