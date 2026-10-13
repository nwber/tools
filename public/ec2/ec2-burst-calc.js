/**
 * Pure burstable-instance simulation for the EC2 burst calculator
 * (unit-tested with vitest; DOM wiring lives in ec2-page.js).
 *
 * Model and assumptions (kept explicit because CPU-credit behavior has a few
 * well-documented subtleties):
 *
 *  - CPU credits: 1 credit = 1 vCPU at 100% for 1 minute. An instance earns a
 *    fixed number of credits per hour while running, regardless of load, and
 *    spends credits when CPU is above its baseline:
 *       spent = vcpu * (cpuPct - baselinePct)/100 * minutes
 *    Below the baseline nothing is spent; the bucket (max = 24h of accrual)
 *    fills and caps.
 *
 *  - Daily profile: one contiguous peak block of `peakMinutesPerDay` at
 *    `peakCpu`, and the rest of the active time (`hoursPerDay`) at a constant
 *    idle level solved so the active-time average equals `avgCpu`:
 *       idle = (avg*activeMinutes - peak*peakMinutes) / (activeMinutes - peakMinutes)
 *    The peak block is modeled at the END of the active day (credits accrued
 *    earlier in the day are available to the burst). The bucket starts empty
 *    (a fresh instance), which is the conservative choice.
 *
 *  - Standard mode: when the bucket is exhausted mid-burst, the instance
 *    drops to the baseline for the remainder — that time is reported as
 *    throttle time and the day is the "time to depletion" day.
 *
 *  - Unlimited mode: no throttling. Surplus credits are billed at the flat
 *    per-vCPU-hour rate whenever the running average exceeds the baseline
 *    (daily steady state): surcharge = vcpu * max(0, avg-baseline)/100 * rate
 *    per active hour. Transient peaks that average back below baseline within
 *    the day are covered by credits and cost nothing.
 *
 *  - Costs use the selected pricing term for both sides (on-demand / RI /
 *    Savings Plan), taken from the generated dataset. Stopped time is free;
 *    only active hours are billed.
 */

export const TERMS = ["onDemand", "ri1yrNoUpfront", "ri3yrNoUpfront", "sp1yrNoUpfront"];

export const TERM_LABELS = {
  onDemand: "On-demand",
  ri1yrNoUpfront: "1-yr RI (no upfront)",
  ri3yrNoUpfront: "3-yr RI (no upfront)",
  sp1yrNoUpfront: "Savings Plan, 1-yr (estimate)",
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits = 4) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/**
 * @param {object} spec - public/data/ec2-burst-spec.json
 * @param {object} inputs
 * @param {string} inputs.type - e.g. "t4g.small"
 * @param {string} inputs.region
 * @param {number} inputs.avgCpu - percent, active-time average
 * @param {number} inputs.peakCpu - percent
 * @param {number} inputs.peakMinutesPerDay
 * @param {number} inputs.hoursPerDay - active hours
 * @param {number} inputs.days
 * @param {"standard" | "unlimited"} inputs.mode
 * @param {keyof TERM_LABELS} inputs.term
 */
export function simulateBurst(spec, inputs) {
  const notes = [];
  const size = spec.sizes.find((s) => s.type === inputs.type);
  if (!size) return { ok: false, error: `unknown instance type ${inputs.type}` };
  const comparison = spec.comparisons.find((c) => c.burstable === inputs.type);
  if (!comparison) return { ok: false, error: `no comparison for ${inputs.type}` };
  const region = spec.regions.find((r) => r.id === inputs.region);
  if (!region) return { ok: false, error: `unknown region ${inputs.region}` };

  const hoursPerDay = clamp(inputs.hoursPerDay, 1, 24);
  const days = clamp(Math.round(inputs.days), 1, 90);
  const activeMinutes = hoursPerDay * 60;
  const peakMinutes = clamp(inputs.peakMinutesPerDay, 0, activeMinutes);
  const idleMinutes = activeMinutes - peakMinutes;
  const peakCpu = clamp(inputs.peakCpu, 0, 100);
  const avgCpu = clamp(inputs.avgCpu, 0, peakCpu > 0 ? peakCpu : 100);
  if (avgCpu !== inputs.avgCpu) notes.push("average CPU was clamped to the peak value");

  // Solve the idle level that makes the active-time average equal avgCpu.
  let idleCpu = 0;
  if (idleMinutes > 0) {
    idleCpu = (avgCpu * activeMinutes - peakCpu * peakMinutes) / idleMinutes;
    if (idleCpu < 0) {
      idleCpu = 0;
      const implied = (peakCpu * peakMinutes) / activeMinutes;
      notes.push(
        `the peak block alone already averages ${round(implied, 1)}% — the effective daily ` +
          `average is higher than the ${avgCpu}% entered`,
      );
    } else if (idleCpu > peakCpu) {
      idleCpu = peakCpu;
      const implied = (peakCpu * peakMinutes + peakCpu * idleMinutes) / activeMinutes;
      notes.push(
        `the entered average is above the peak level; using ${peakCpu}% throughout ` +
          `(${implied}% average)`,
      );
    }
  }

  const baseline = size.baselinePct;
  const vcpu = size.vcpu;
  const earnedPerDay = size.creditsPerHour * hoursPerDay;
  const spendAt = (cpuPct, minutes) => vcpu * (Math.max(0, cpuPct - baseline) / 100) * minutes;
  const minutesFor = (credits, cpuPct) => {
    const perMinute = vcpu * (Math.max(0, cpuPct - baseline) / 100);
    return perMinute > 0 ? credits / perMinute : Number.POSITIVE_INFINITY;
  };
  const idleSpend = spendAt(idleCpu, idleMinutes);
  const peakSpend = spendAt(peakCpu, peakMinutes);

  const standard = inputs.mode === "standard";
  const timeline = [];
  let bucket = 0;
  let timeToDepletionDay = null;
  let totalThrottledMinutes = 0;

  for (let day = 1; day <= days; day += 1) {
    let throttledMinutes = 0;
    // Credits earned during the day, then the below/at-baseline load, then
    // the peak block at the end of the day.
    bucket = Math.min(bucket + earnedPerDay, size.maxCredits);
    if (spendAt(idleCpu, idleMinutes) > bucket) {
      const deficit = spendAt(idleCpu, idleMinutes) - bucket;
      if (standard) {
        throttledMinutes += Math.min(minutesFor(deficit, idleCpu), idleMinutes);
      }
      bucket = 0;
    } else {
      bucket -= spendAt(idleCpu, idleMinutes);
    }
    if (spendAt(peakCpu, peakMinutes) > bucket) {
      const deficit = spendAt(peakCpu, peakMinutes) - bucket;
      if (standard) {
        throttledMinutes += Math.min(minutesFor(deficit, peakCpu), peakMinutes);
      }
      bucket = 0;
    } else {
      bucket -= spendAt(peakCpu, peakMinutes);
    }
    if (standard && throttledMinutes > 0 && timeToDepletionDay === null) {
      timeToDepletionDay = day;
    }
    totalThrottledMinutes += throttledMinutes;
    timeline.push({
      day,
      bucket: round(bucket, 2),
      throttledMinutes: round(throttledMinutes, 1),
    });
  }

  if (idleSpend > 0) {
    notes.push(
      `off-peak utilization (${round(idleCpu, 1)}%) is above the ${baseline}% baseline, ` +
        `so it spends credits too`,
    );
  }

  // Costs. Both sides use the same term and active hours.
  const rates = spec.prices[inputs.type];
  const term = TERMS.includes(inputs.term) ? inputs.term : "onDemand";
  const rateFor = (side) => rates[side][region.id]?.[term];
  let burstableRate = rateFor("burstable");
  let candidateRate = rateFor("candidate");
  if (burstableRate == null || candidateRate == null) {
    const missing = [burstableRate == null && "burstable", candidateRate == null && "candidate"]
      .filter(Boolean)
      .join(" and ");
    notes.push(
      `${TERM_LABELS[term]} pricing is not published yet for the ${missing} instance; ` +
        `falling back to on-demand`,
    );
    burstableRate = rateFor("burstable") ?? rates.burstable[region.id]?.onDemand;
    candidateRate = rateFor("candidate") ?? rates.candidate[region.id]?.onDemand;
  }
  const activeHours = hoursPerDay * days;
  const burstableBase = burstableRate * activeHours;
  const surchargePerHour =
    vcpu * (Math.max(0, avgCpu - baseline) / 100) * spec.families[size.family].unlimitedSurchargePerVcpuHour;
  const surcharge = standard ? 0 : surchargePerHour * activeHours;
  const burstableTotal = burstableBase + surcharge;
  const candidateTotal = candidateRate * activeHours;

  // The average CPU at which unlimited mode costs the same as the candidate.
  const surchargeRate = spec.families[size.family].unlimitedSurchargePerVcpuHour;
  const breakevenAvgPct =
    baseline + ((candidateRate - burstableRate) * 100) / (vcpu * surchargeRate);

  const throttledPerDay = totalThrottledMinutes / days;
  const candidateIsCheaper = candidateTotal < burstableTotal;
  let summary;
  if (standard) {
    if (totalThrottledMinutes > 0) {
      summary =
        `Standard-mode credits run out after ${timeToDepletionDay} day(s); ` +
        `throttled for ~${round(throttledPerDay, 1)} min/day after that. ` +
        `Unlimited mode covers the peak for $${round(surchargePerHour * activeHours, 2)} over the ` +
        `period (total $${round(burstableBase + surchargePerHour * activeHours, 2)} vs ` +
        `$${round(candidateTotal, 2)} for the non-burstable equivalent); ` +
        (candidateTotal < burstableBase + surchargePerHour * activeHours
          ? "the non-burstable instance is the cheaper way to keep the peak."
          : "unlimited mode is still the cheaper way to keep the peak.");
    } else {
      summary =
        `Standard mode covers this profile for the whole period ` +
        `($${round(burstableTotal, 2)} vs $${round(candidateTotal, 2)} for the ` +
        `non-burstable equivalent). No throttling expected.`;
    }
  } else if (candidateIsCheaper) {
    summary =
      `At a ${avgCpu}% average, unlimited-mode surcharges make this instance costlier than the ` +
      `non-burstable equivalent ($${round(burstableTotal, 2)} vs $${round(candidateTotal, 2)}). ` +
      `Unlimited stays cheaper below a ${round(breakevenAvgPct, 1)}% average.`;
  } else {
    summary =
      `Unlimited mode keeps full performance with no throttling and stays cheaper than the ` +
      `non-burstable equivalent ($${round(burstableTotal, 2)} vs $${round(candidateTotal, 2)}). ` +
      `It would lose that edge above a ${round(breakevenAvgPct, 1)}% average.`;
  }

  return {
    ok: true,
    profile: {
      idleCpu: round(idleCpu, 1),
      peakCpu,
      peakMinutesPerDay: round(peakMinutes, 1),
      hoursPerDay,
      days,
      avgCpu,
    },
    size,
    comparison: {
      type: comparison.candidate,
      exact: comparison.exact,
      vcpu: comparison.candidateVcpu,
      memoryGiB: comparison.candidateMemoryGiB,
      alternatives: comparison.candidates.filter((t) => t !== comparison.candidate),
    },
    credits: {
      baselinePct: baseline,
      earnedPerDay: round(earnedPerDay, 2),
      peakSpendPerDay: round(peakSpend, 2),
      idleSpendPerDay: round(idleSpend, 2),
      maxCredits: size.maxCredits,
      timeToDepletionDay,
      totalThrottledMinutes: round(totalThrottledMinutes, 1),
      throttledMinutesPerDay: round(throttledPerDay, 2),
    },
    costs: {
      term,
      hours: activeHours,
      burstable: {
        rate: round(burstableRate, 5),
        base: round(burstableBase, 2),
        surcharge: round(surcharge, 2),
        total: round(burstableTotal, 2),
      },
      candidate: {
        rate: round(candidateRate, 5),
        total: round(candidateTotal, 2),
        vcpu: comparison.candidateVcpu,
        memoryGiB: comparison.candidateMemoryGiB,
      },
      breakevenAvgPct: round(breakevenAvgPct, 1),
    },
    timeline,
    notes,
    summary,
  };
}
