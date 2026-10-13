/**
 * Tests for the burst simulation (public/ec2/ec2-burst-calc.js) against the
 * generated dataset. Cases are hand-computed from the documented credit math:
 * 1 credit = 1 vCPU at 100% for 1 minute.
 */

import { describe, expect, it } from "vitest";

import spec from "../public/data/ec2-burst-spec.json";
import { simulateBurst } from "../public/ec2/ec2-burst-calc.js";

type Inputs = Parameters<typeof simulateBurst>[1];

const inputs = (overrides: Partial<Inputs> = {}): Inputs => ({
  type: "t3a.small", // 2 vCPU, 20% baseline, 24 credits/hour, 576 max
  region: "us-east-1",
  avgCpu: 15,
  peakCpu: 100,
  peakMinutesPerDay: 120,
  hoursPerDay: 24,
  days: 30,
  mode: "standard",
  term: "onDemand",
  ...overrides,
});

/** The shape of a successful simulation run (mirrors ec2-burst-calc.js). */
type SimResult = {
  ok: true;
  profile: {
    idleCpu: number;
    peakCpu: number;
    peakMinutesPerDay: number;
    hoursPerDay: number;
    days: number;
    avgCpu: number;
  };
  size: {
    type: string;
    vcpu: number;
    memoryGiB: number;
    baselinePct: number;
    creditsPerHour: number;
    maxCredits: number;
  };
  comparison: {
    type: string;
    exact: boolean;
    vcpu: number;
    memoryGiB: number;
    alternatives: string[];
  };
  credits: {
    baselinePct: number;
    earnedPerDay: number;
    peakSpendPerDay: number;
    idleSpendPerDay: number;
    maxCredits: number;
    timeToDepletionDay: number | null;
    totalThrottledMinutes: number;
    throttledMinutesPerDay: number;
  };
  costs: {
    term: string;
    hours: number;
    burstable: { rate: number; base: number; surcharge: number; total: number };
    candidate: { rate: number; total: number; vcpu: number; memoryGiB: number };
    breakevenAvgPct: number;
  };
  timeline: Array<{ day: number; bucket: number; throttledMinutes: number }>;
  notes: string[];
  summary: string;
};

/**
 * Runs the simulation, failing the test if it did not succeed. The cast is
 * the JS/TS boundary: the module's inferred return type widens the `ok`
 * discriminant, so TypeScript cannot narrow it here.
 */
const run = (overrides: Partial<Inputs> = {}): SimResult => {
  const result = simulateBurst(spec, inputs(overrides)) as unknown as
    | SimResult
    | { ok: false; error: string };
  if (!result.ok) throw new Error(`simulation failed: ${result.error}`);
  return result;
};

describe("simulateBurst", () => {
  it("rejects unknown types", () => {
    const result = simulateBurst(spec, inputs({ type: "m9x.mega" }));
    expect(result.ok).toBe(false);
  });

  it("computes the daily profile and credit flows", () => {
    // idle = (15*1440 - 100*120) / 1320 = 7.27%
    // earned = 24 * 24 = 576/day; peak spend above baseline = 2 * 0.8 * 120 = 192/day
    // net +384/day -> bucket fills to the 576 cap and never depletes.
    const result = run({});
    expect(result.ok).toBe(true);
    expect(result.profile.idleCpu).toBeCloseTo(7.3, 1);
    expect(result.credits.earnedPerDay).toBe(576);
    expect(result.credits.peakSpendPerDay).toBe(192);
    expect(result.credits.idleSpendPerDay).toBe(0);
    expect(result.credits.timeToDepletionDay).toBeNull();
    expect(result.credits.totalThrottledMinutes).toBe(0);
    // End-of-day bucket plateaus at cap - peak spend (earning is capped
    // before the end-of-day peak is served): 576 - 192 = 384.
    const last = result.timeline[result.timeline.length - 1];
    expect(last.bucket).toBe(384);
  });

  it("detects depletion and throttling when the average exceeds the baseline", () => {
    // avg 30%, peak 100%, 400 peak min/day: idle = (30*1440 - 100*400)/1040 = 3.08%
    // peak spend = 2 * 0.8 * 400 = 640/day vs 576 earned (bucket caps at 576):
    // day 1 deficit = 64 credits -> 64 / (2 * 0.8) = 40 min/day at 100%,
    // every day at steady state.
    const result = run({ avgCpu: 30, peakMinutesPerDay: 400 });
    expect(result.profile.idleCpu).toBeCloseTo(3.1, 1);
    expect(result.credits.timeToDepletionDay).toBe(1);
    expect(result.credits.throttledMinutesPerDay).toBeCloseTo(40, 0);
  });

  it("prices unlimited-mode surcharge on the excess over baseline", () => {
    // excess = 30 - 20 = 10%; surcharge = 2 vCPU * 0.10 * $0.05 * 24h = $0.24/day
    const result = run({ avgCpu: 30, mode: "unlimited" });
    expect(result.costs.burstable.surcharge).toBeCloseTo(0.24 * 30, 2);
    expect(result.credits.totalThrottledMinutes).toBe(0);
    // base = 0.0188/h * 24h * 30d
    expect(result.costs.burstable.base).toBeCloseTo(0.0188 * 24 * 30, 2);
    expect(result.costs.burstable.total).toBeCloseTo(
      result.costs.burstable.base + result.costs.burstable.surcharge,
      2,
    );
  });

  it("charges no surcharge when the average is below the baseline", () => {
    const result = run({ mode: "unlimited" });
    expect(result.costs.burstable.surcharge).toBe(0);
  });

  it("compares against the non-burstable candidate with the same term", () => {
    // t3a.small -> m5a.large ($0.086/h on demand in us-east-1)
    const result = run({ days: 30 });
    expect(result.comparison.type).toBe("m5a.large");
    expect(result.comparison.exact).toBe(false);
    expect(result.costs.candidate.total).toBeCloseTo(0.086 * 24 * 30, 1);
    expect(result.costs.candidate.vcpu).toBe(2);
    expect(result.costs.candidate.memoryGiB).toBe(8);
  });

  it("computes the breakeven average CPU for unlimited mode", () => {
    // baseline + (candidate_rate - burstable_rate) * 100 / (vcpu * surcharge)
    // 20 + (0.086 - 0.0188) * 100 / (2 * 0.05) = 20 + 67.2 = 87.2
    const result = run({ mode: "unlimited" });
    expect(result.costs.breakevenAvgPct).toBeCloseTo(87.2, 1);
  });

  it("falls back to on-demand with a note when the term is unpublished", () => {
    // t8i has no reserved pricing in the dataset yet.
    const result = run({ type: "t8i.medium", avgCpu: 10, term: "ri1yrNoUpfront" });
    expect(result.costs.term).toBe("ri1yrNoUpfront");
    expect(result.costs.burstable.rate).toBeCloseTo(0.04992, 5);
    expect(result.notes.join(" ")).toContain("falling back to on-demand");
  });

  it("uses RI pricing for both sides when published", () => {
    const result = run({ type: "t4g.medium", term: "ri1yrNoUpfront" });
    const prices = spec.prices["t4g.medium"];
    expect(result.costs.burstable.rate).toBeCloseTo(
      prices.burstable["us-east-1"].ri1yrNoUpfront,
      5,
    );
    expect(result.costs.candidate.rate).toBeCloseTo(
      prices.candidate["us-east-1"].ri1yrNoUpfront,
      5,
    );
  });

  it("clamps impossible profiles and notes the effective average", () => {
    // peak block alone averages 50% — above the 10% entered.
    const result = run({ avgCpu: 10, peakCpu: 100, peakMinutesPerDay: 720, hoursPerDay: 24 });
    expect(result.profile.idleCpu).toBe(0);
    expect(result.notes.join(" ")).toContain("effective daily average");
  });

  it("notes when off-peak load itself is above the baseline", () => {
    // avg 40% requires idle 40% > baseline 20% -> idle spends credits.
    const result = run({ avgCpu: 40, peakCpu: 40, peakMinutesPerDay: 10 });
    expect(result.notes.join(" ")).toContain("above the 20% baseline");
    expect(result.credits.idleSpendPerDay).toBeGreaterThan(0);
  });

  it("produces a day-by-day timeline", () => {
    const result = run({ days: 7 });
    expect(result.timeline).toHaveLength(7);
    expect(result.timeline[0].day).toBe(1);
    expect(result.timeline[6].day).toBe(7);
  });
});
