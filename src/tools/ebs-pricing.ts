/**
 * EBS pricing calculator (pure; unit-tested with vitest).
 *
 * The prices below are a *representative snapshot* — realistic shapes and
 * magnitudes, not verified AWS quotes. The real dataset (refreshed from the
 * AWS Price List API) lands with the Phase 1 EBS port.
 */

export const EBS_VOLUME_TYPES = ["gp2", "gp3", "io1", "io2", "st1", "sc1"] as const;
export type EbsVolumeType = (typeof EBS_VOLUME_TYPES)[number];

// Commercial AWS regions as of late 2026 (GovCloud and China partitions
// excluded — the real dataset owns that nuance).
export const EBS_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ca-central-1",
  "ca-west-1",
  "sa-east-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
  "ap-south-1",
  "ap-south-2",
  "ap-east-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ap-southeast-5",
  "ap-southeast-6",
  "ap-southeast-7",
  "me-south-1",
  "me-central-1",
  "me-central-2",
  "af-south-1",
  "il-central-1",
  "mx-central-1",
] as const;
export type EbsRegion = (typeof EBS_REGIONS)[number];

// Price multiplier per region relative to us-east-1 (representative).
const REGION_MULTIPLIER: Record<EbsRegion, number> = {
  "us-east-1": 1.0,
  "us-east-2": 1.0,
  "us-west-1": 1.1,
  "us-west-2": 1.0,
  "ca-central-1": 1.1,
  "ca-west-1": 1.15,
  "sa-east-1": 1.25,
  "eu-west-1": 1.08,
  "eu-west-2": 1.1,
  "eu-west-3": 1.08,
  "eu-central-1": 1.08,
  "eu-central-2": 1.12,
  "eu-north-1": 1.08,
  "eu-south-1": 1.15,
  "eu-south-2": 1.1,
  "ap-south-1": 1.09,
  "ap-south-2": 1.12,
  "ap-east-1": 1.25,
  "ap-northeast-1": 1.12,
  "ap-northeast-2": 1.15,
  "ap-northeast-3": 1.12,
  "ap-southeast-1": 1.12,
  "ap-southeast-2": 1.15,
  "ap-southeast-3": 1.15,
  "ap-southeast-4": 1.2,
  "ap-southeast-5": 1.15,
  "ap-southeast-6": 1.12,
  "ap-southeast-7": 1.15,
  "me-south-1": 1.2,
  "me-central-1": 1.15,
  "me-central-2": 1.12,
  "af-south-1": 1.35,
  "il-central-1": 1.2,
  "mx-central-1": 1.15,
};

interface Rates {
  readonly storagePerGb: number;
  /** gp3: IOPS free allowance before per-unit billing. */
  readonly iopsIncluded?: number;
  /** io1/io2: billed from the first provisioned IOPS. gp3: above the allowance. */
  readonly iopsPerUnit?: number;
  /** gp3: throughput (MB/s) free allowance before per-unit billing. */
  readonly thptIncludedMbps?: number;
  readonly thptPerMbps?: number;
}

// us-east-1-equivalent baseline rates, USD per month (representative).
// - gp2/st1/sc1 price storage only.
// - io2's real pricing is tiered; simplified here.
const RATES: Record<EbsVolumeType, Rates> = {
  gp2: { storagePerGb: 0.1 },
  gp3: {
    storagePerGb: 0.08,
    iopsIncluded: 3000,
    iopsPerUnit: 0.005,
    thptIncludedMbps: 125,
    thptPerMbps: 0.04,
  },
  io1: { storagePerGb: 0.125, iopsPerUnit: 0.065 },
  io2: { storagePerGb: 0.065, iopsPerUnit: 0.065 },
  st1: { storagePerGb: 0.045 },
  sc1: { storagePerGb: 0.015 },
};

export const MAX_VOLUME_GB = 16384; // 16 TiB
export const MAX_IOPS = 256_000;
export const MAX_THROUGHPUT_MBPS = 4000;

const DEFAULT_SIZE_GB = 100;

export interface EbsInputs {
  readonly sizeGb: number;
  readonly iops?: number;
  readonly throughputMbps?: number;
  readonly regions: readonly EbsRegion[];
}

export type ParseResult =
  | { readonly ok: true; readonly inputs: EbsInputs }
  | { readonly ok: false; readonly error: string };

export interface EbsLineItem {
  storage_usd: number;
  iops_usd: number;
  throughput_usd: number;
  total_usd: number;
  note?: string;
}

export interface EbsTotals {
  storage_usd: number;
  iops_usd: number;
  throughput_usd: number;
  grand_usd: number;
}

export interface EbsMatrixResult {
  readonly matrix: Record<EbsVolumeType, Record<string, EbsLineItem>>;
  readonly totals: EbsTotals;
  readonly lineItems: number;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

type IntResult =
  | { readonly ok: true; readonly value: number | undefined }
  | { readonly ok: false; readonly error: string };

/** Parse an optional integer with inclusive bounds; `null`/`undefined`/absent mean "not provided". */
function parseIntValue(name: string, raw: unknown, min: number, max: number): IntResult {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  let value: number;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) return { ok: false, error: `${name} must be an integer` };
    value = raw;
  } else if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) {
    value = Number(raw.trim());
  } else {
    return { ok: false, error: `${name} must be an integer` };
  }
  if (value < min || value > max) {
    return { ok: false, error: `${name} must be between ${min} and ${max}` };
  }
  return { ok: true, value };
}

type RegionsResult =
  | { readonly ok: true; readonly value: readonly EbsRegion[] }
  | { readonly ok: false; readonly error: string };

function parseRegions(raw: unknown): RegionsResult {
  if (raw === undefined || raw === null) return { ok: true, value: EBS_REGIONS };
  let items: string[];
  if (typeof raw === "string") {
    items = raw.split(",");
  } else if (Array.isArray(raw)) {
    items = raw.map((item) => String(item));
  } else {
    return { ok: false, error: "regions must be a comma-separated string or a list" };
  }
  const requested = items.map((item) => item.trim()).filter((item) => item.length > 0);
  const known = new Set<string>(EBS_REGIONS);
  const unknown = requested.filter((region) => !known.has(region));
  if (unknown.length > 0) {
    return { ok: false, error: `unknown regions: ${unknown.join(", ")}` };
  }
  if (requested.length === 0) {
    return { ok: false, error: "regions cannot be empty" };
  }
  return { ok: true, value: requested as EbsRegion[] };
}

/** Build validated inputs from query params (strings) or a JSON body (unknowns). */
export function parseEbsInputs(values: Record<string, unknown>): ParseResult {
  const size = parseIntValue("size_gb", values["size_gb"], 1, MAX_VOLUME_GB);
  if (!size.ok) return size;
  const iops = parseIntValue("iops", values["iops"], 0, MAX_IOPS);
  if (!iops.ok) return iops;
  const throughput = parseIntValue(
    "throughput_mbps",
    values["throughput_mbps"],
    0,
    MAX_THROUGHPUT_MBPS,
  );
  if (!throughput.ok) return throughput;
  const regions = parseRegions(values["regions"]);
  if (!regions.ok) return regions;
  const inputs: EbsInputs = {
    sizeGb: size.value ?? DEFAULT_SIZE_GB,
    regions: regions.value,
  };
  return {
    ok: true,
    inputs: {
      ...inputs,
      ...(iops.value !== undefined ? { iops: iops.value } : {}),
      ...(throughput.value !== undefined ? { throughputMbps: throughput.value } : {}),
    },
  };
}

/** Monthly cost of one (volume type, region) combination, USD. */
export function ebsLineItem(
  volumeType: EbsVolumeType,
  region: EbsRegion,
  sizeGb: number,
  iops?: number,
  throughputMbps?: number,
): EbsLineItem {
  const multiplier = REGION_MULTIPLIER[region];
  const rates = RATES[volumeType];
  const storage = sizeGb * rates.storagePerGb * multiplier;
  let iopsCost = 0;
  let thptCost = 0;
  let note: string | undefined;
  if (volumeType === "gp3") {
    if (iops !== undefined && iops > (rates.iopsIncluded ?? 0)) {
      iopsCost = (iops - (rates.iopsIncluded ?? 0)) * (rates.iopsPerUnit ?? 0) * multiplier;
    }
    if (throughputMbps !== undefined && throughputMbps > (rates.thptIncludedMbps ?? 0)) {
      thptCost =
        (throughputMbps - (rates.thptIncludedMbps ?? 0)) *
        (rates.thptPerMbps ?? 0) *
        multiplier;
    }
  } else if (volumeType === "io1" || volumeType === "io2") {
    iopsCost = (iops ?? 0) * (rates.iopsPerUnit ?? 0) * multiplier;
  } else if (iops !== undefined || throughputMbps !== undefined) {
    // gp2, st1, sc1 price storage only; provided params are ignored.
    note = "provisioned iops/throughput not supported for this volume type";
  }
  const item: EbsLineItem = {
    storage_usd: round4(storage),
    iops_usd: round4(iopsCost),
    throughput_usd: round4(thptCost),
    total_usd: round4(storage + iopsCost + thptCost),
  };
  if (note !== undefined) item.note = note;
  return item;
}

/** Price the inputs across every requested region and volume type. */
export function computeEbsMatrix(inputs: EbsInputs): EbsMatrixResult {
  const matrix = {} as Record<EbsVolumeType, Record<string, EbsLineItem>>;
  const totals: EbsTotals = {
    storage_usd: 0,
    iops_usd: 0,
    throughput_usd: 0,
    grand_usd: 0,
  };
  for (const volumeType of EBS_VOLUME_TYPES) {
    const perRegion: Record<string, EbsLineItem> = {};
    for (const region of inputs.regions) {
      const item = ebsLineItem(
        volumeType,
        region,
        inputs.sizeGb,
        inputs.iops,
        inputs.throughputMbps,
      );
      perRegion[region] = item;
      totals.storage_usd += item.storage_usd;
      totals.iops_usd += item.iops_usd;
      totals.throughput_usd += item.throughput_usd;
      totals.grand_usd += item.total_usd;
    }
    matrix[volumeType] = perRegion;
  }
  return {
    matrix,
    totals: {
      storage_usd: round4(totals.storage_usd),
      iops_usd: round4(totals.iops_usd),
      throughput_usd: round4(totals.throughput_usd),
      grand_usd: round4(totals.grand_usd),
    },
    lineItems: EBS_VOLUME_TYPES.length * inputs.regions.length,
  };
}
