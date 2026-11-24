/**
 * Pure pricing math for the EBS pricing comparator (unit-tested with vitest).
 *
 * This is a faithful port of the calculation embedded in the original tool
 * (recovered from ebs-pricing-comparator.nwber.workers.dev): same formulas,
 * same baselines, same limits, same warning texts. Only the structure changed
 * so the math can be tested without a DOM; the page wiring lives in
 * ebs-page.js.
 *
 * Exports:
 *   calculateRows    the comparison table (one row per selected type)
 *   calculateSeries  the cost graph (one curve per selected type, sweeping
 *                    IOPS, throughput, or size up to 1.5x that input's
 *                    current value while holding the others)
 */

/**
 * @typedef {object} EbsRow
 * @property {string} type
 * @property {string} durability
 * @property {boolean} error
 * @property {boolean} meets
 * @property {number | null} storage
 * @property {number | null} iopsCost
 * @property {number | null} throughputCost
 * @property {number | null} total
 */

/**
 * @typedef {object} EbsSeriesPoint
 * @property {number} x - the swept input's value
 * @property {number} y - the total monthly cost in USD
 */

/**
 * @typedef {object} EbsSeries
 * @property {string} type
 * @property {string} name
 * @property {EbsSeriesPoint[]} points - empty when the type cannot meet
 *   the held inputs at any x (the table shows the same type as ERROR)
 */

/**
 * True when the configuration fits within the volume type's limits — the
 * condition behind the table's ERROR rows.
 *
 * @param {object} volume - a pricing.volumeTypes entry
 * @param {object} config
 * @param {number} config.sizeGB
 * @param {number} config.iops
 * @param {number} config.throughput - MiB/s
 */
const withinLimits = (volume, config) =>
  config.sizeGB <= volume.maxVolumeSize &&
  config.iops <= volume.maxIOPS &&
  config.throughput <= volume.maxThroughput;

/**
 * Cost of one volume configuration, same formulas as the original tool:
 * storage plus provisioned amounts above the type's baselines, billed at
 * the region's rates (only when the type's pricing carries a rate).
 *
 * @param {object} volume - a pricing.volumeTypes entry
 * @param {object} prices - the volume's pricing entry for the region
 * @param {object} config
 * @param {number} config.sizeGB
 * @param {number} config.iops
 * @param {number} config.throughput - MiB/s
 * @returns {{ storage: number, iopsCost: number, throughputCost: number, total: number }}
 */
const costAt = (volume, prices, config) => {
  const { sizeGB, iops, throughput } = config;
  const storage = sizeGB * prices.perGB;
  let iopsCost = 0;
  let throughputCost = 0;
  if (prices.provisionedIOPS && iops > volume.baselineIOPS) {
    iopsCost = (iops - volume.baselineIOPS) * prices.provisionedIOPS;
  }
  if (prices.provisionedThroughput && throughput > volume.baselineThroughput) {
    throughputCost = (throughput - volume.baselineThroughput) * prices.provisionedThroughput;
  }
  return { storage, iopsCost, throughputCost, total: storage + iopsCost + throughputCost };
};

/**
 * The comparison table: one row per selected volume type at the given
 * configuration, with the original tool's limit warnings.
 *
 * @param {object} pricing - the parsed public/data/ebs-pricing.json
 * @param {object} inputs
 * @param {string} inputs.region
 * @param {number} inputs.size
 * @param {"GB" | "TB"} inputs.unit
 * @param {number} inputs.iops
 * @param {number} inputs.throughput - MiB/s
 * @param {string[]} inputs.selectedTypes
 * @returns {{ rows: EbsRow[], warnings: string[] }}
 */
export function calculateRows(pricing, inputs) {
  const { region, size, unit, iops, throughput, selectedTypes } = inputs;
  const sizeGB = unit === "TB" ? size * 1024 : size;
  const rows = [];
  const warnings = [];

  Object.entries(pricing.volumeTypes).forEach(([type, volume]) => {
    if (!selectedTypes.includes(type)) return;
    const prices = volume.pricing[region];
    if (!prices) return;

    let storage = null;
    let iopsCost = null;
    let throughputCost = null;
    let total = null;
    let error = false;
    let meets = true;

    if (sizeGB > volume.maxVolumeSize) {
      warnings.push(volume.name + " exceeds max size of " + volume.maxVolumeSize + "GiB");
      error = true;
      meets = false;
    }
    if (iops > volume.maxIOPS) {
      warnings.push(volume.name + " exceeds max IOPS of " + volume.maxIOPS);
      error = true;
      meets = false;
    }
    if (throughput > volume.maxThroughput) {
      warnings.push(
        volume.name + " exceeds max throughput of " + volume.maxThroughput + "MiB/s",
      );
      error = true;
      meets = false;
    }

    if (!error) {
      ({ storage, iopsCost, throughputCost, total } = costAt(volume, prices, {
        sizeGB,
        iops,
        throughput,
      }));
    }

    rows.push({
      type,
      durability: volume.durability,
      error,
      meets,
      storage,
      iopsCost,
      throughputCost,
      total,
    });
  });

  return { rows, warnings };
}

/**
 * Axes the cost graph can sweep: the input varied, the volume attribute that
 * caps it, and the baseline attribute where the cost slope can kink (null
 * when the cost is linear across the whole axis).
 */
const GRAPH_AXES = {
  iops: { key: "iops", max: "maxIOPS", baseline: "baselineIOPS" },
  throughput: { key: "throughput", max: "maxThroughput", baseline: "baselineThroughput" },
  size: { key: "sizeGB", max: "maxVolumeSize", baseline: null },
};

/**
 * The cost graph: one curve per selected volume type as one input is swept
 * from 0 up to 1.5x that input's current value — so the calculator's own
 * configuration sits at two-thirds of the X axis — holding the other
 * inputs at the given values. A type whose own limit is closer than the
 * cap ends there instead.
 *
 * Cost is piecewise linear in each input (flat until the baseline, then the
 * provisioned rate's slope), so a curve is exact at just its vertices: 0,
 * the baseline when it lies inside the range, and the curve's end.
 *
 * A type whose held inputs already exceed its limits has no valid
 * configuration at any x — it is returned with empty points (the table
 * shows the same type as an ERROR row) so the legend can still list it.
 * Types without pricing for the region are skipped, like the table.
 *
 * @param {object} pricing - the parsed public/data/ebs-pricing.json
 * @param {object} inputs
 * @param {string} inputs.region
 * @param {number} inputs.size
 * @param {"GB" | "TB"} inputs.unit
 * @param {number} inputs.iops
 * @param {number} inputs.throughput - MiB/s
 * @param {string[]} inputs.selectedTypes
 * @param {("iops" | "throughput" | "size")} inputs.axis
 * @returns {{ axis: string, limit: number, series: EbsSeries[] }}
 *   limit is the X-axis upper bound: 1.5x the swept input's current value,
 *   or the widest selected type's limit when that value is 0 or missing.
 */
export function calculateSeries(pricing, inputs) {
  const { region, size, unit, iops, throughput, selectedTypes, axis } = inputs;
  const axisSpec = GRAPH_AXES[axis];
  const sizeGB = unit === "TB" ? size * 1024 : size;
  const base = { sizeGB, iops, throughput };
  const series = [];

  if (!axisSpec) return { axis, limit: 0, series };

  // X-axis upper bound: the swept input's current value + 50%. Zero,
  // negative, or missing values fall back to each type's full range.
  const swept = base[axisSpec.key];
  const cap = Number.isFinite(swept) && swept > 0 ? swept * 1.5 : null;
  let widest = 0;

  Object.entries(pricing.volumeTypes).forEach(([type, volume]) => {
    if (!selectedTypes.includes(type)) return;
    const prices = volume.pricing[region];
    if (!prices) return;

    const maxX = cap !== null ? Math.min(volume[axisSpec.max], cap) : volume[axisSpec.max];
    widest = Math.max(widest, volume[axisSpec.max]);

    const at = (x) => ({ ...base, [axisSpec.key]: x });
    const xs = [0];
    const baseline = axisSpec.baseline ? volume[axisSpec.baseline] : null;
    if (baseline !== null && baseline > 0 && baseline < maxX) xs.push(baseline);
    xs.push(maxX);

    series.push({
      type,
      name: volume.name,
      points: xs
        .filter((x) => withinLimits(volume, at(x)))
        .map((x) => ({ x, y: costAt(volume, prices, at(x)).total })),
    });
  });

  return { axis, limit: cap ?? widest, series };
}
