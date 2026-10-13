/**
 * Pure measurement math for the speed test page (unit-tested with vitest).
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

/** Throughput in megabits per second. */
export function mbps(bytes, ms) {
  if (ms <= 0 || bytes <= 0) return 0;
  return (bytes * 8) / (ms / 1000) / 1e6;
}

/** One-decimal Mbps formatting, no thousands separators. */
export function formatMbps(value) {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

/** Latency summary for a set of RTT samples (ms). */
export function latencySummary(samples) {
  return {
    min: Math.round(min(samples) * 10) / 10,
    median: Math.round(median(samples) * 10) / 10,
    jitter: Math.round(jitter(samples) * 10) / 10,
    samples: samples.length,
  };
}
