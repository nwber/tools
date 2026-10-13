/**
 * Pure measurement math and URL helpers for the AWS region latency page
 * (unit-tested with vitest).
 *
 * The sample statistics mirror public/speedtest/speedtest-calc.js — the two
 * tools measure the same kind of round-trip samples and should not drift
 * apart (same median/min/jitter semantics, same one-decimal rounding).
 */

/** Median of a sample array (empty → 0). */
export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Minimum of a sample array (empty → 0). */
export function min(values) {
  return values.length === 0 ? 0 : Math.min(...values);
}

/**
 * Jitter as the mean absolute difference between successive samples
 * (the classic ping jitter measure).
 */
export function jitter(samples) {
  if (samples.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < samples.length; i += 1) {
    total += Math.abs(samples[i] - samples[i - 1]);
  }
  return total / (samples.length - 1);
}

const round1 = (value) => Math.round(value * 10) / 10;

/** RTT summary for a set of samples (ms), one decimal. */
export function summarize(samples) {
  return {
    min: round1(min(samples)),
    median: round1(median(samples)),
    jitter: round1(jitter(samples)),
    samples: samples.length,
  };
}

/**
 * Expand the dataset's probe template for one region. Throws on a template
 * without the {region} placeholder so a bad dataset fails loudly instead of
 * probing the same URL for every region.
 */
export function probeUrl(template, regionCode) {
  if (!template.includes("{region}")) {
    throw new Error(`probe template has no {region} placeholder: ${template}`);
  }
  return template.replaceAll("{region}", regionCode);
}

/**
 * Sort rows by summary.median ascending, unmeasured rows last (keeping their
 * original relative order), so the table ranks regions while results stream
 * in. Ties keep their input order (Array#sort is stable).
 */
export function sortByMedian(rows) {
  return [...rows].sort((a, b) => {
    const am = a.summary?.median ?? Infinity;
    const bm = b.summary?.median ?? Infinity;
    if (am === bm) return 0;
    return am - bm;
  });
}
