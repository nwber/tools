/**
 * Pure pricing math for the EBS pricing comparator (unit-tested with vitest).
 *
 * This is a faithful port of the calculation embedded in the original tool
 * (recovered from ebs-pricing-comparator.nwber.workers.dev): same formulas,
 * same baselines, same limits, same warning texts. Only the structure changed
 * so the math can be tested without a DOM; the page wiring lives in
 * ebs-page.js.
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
      storage = sizeGB * prices.perGB;
      iopsCost = 0;
      throughputCost = 0;
      if (prices.provisionedIOPS && iops > volume.baselineIOPS) {
        iopsCost = (iops - volume.baselineIOPS) * prices.provisionedIOPS;
      }
      if (prices.provisionedThroughput && throughput > volume.baselineThroughput) {
        throughputCost = (throughput - volume.baselineThroughput) * prices.provisionedThroughput;
      }
      total = storage + iopsCost + throughputCost;
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
