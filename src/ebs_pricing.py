"""EBS pricing calculator for the Phase 0 CPU spike.

This is the "one realistic compute endpoint" from the plan: a pricing calc run
over all EBS volume types x AWS regions, computed server-side, so we can
measure how much of the Workers free plan 10 ms CPU budget it consumes.

The prices below are a *representative synthetic snapshot* (realistic shapes
and magnitudes, not verified AWS quotes). Phase 1 replaces this dataset with
the real ported tables (public/data/ebs-pricing.json); this module exists so
the CPU question can be answered now.

Everything in here is pure stdlib with no Workers SDK / FFI imports, so it
runs under plain pytest locally and gets snapshotted into the Worker at
deploy time.
"""

import dataclasses
from collections.abc import Mapping

# gp2/gp3/io1/io2/st1/sc1 — the six EBS volume types with distinct pricing.
EBS_VOLUME_TYPES: tuple[str, ...] = ("gp2", "gp3", "io1", "io2", "st1", "sc1")

# Commercial AWS regions as of late 2026 (approximate coverage; GovCloud and
# China partitions excluded — the real dataset in Phase 1 owns that nuance).
EBS_REGIONS: tuple[str, ...] = (
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
)

# Price multiplier per region relative to us-east-1 (representative).
_REGION_MULTIPLIER: dict[str, float] = {
    "us-east-1": 1.00,
    "us-east-2": 1.00,
    "us-west-1": 1.10,
    "us-west-2": 1.00,
    "ca-central-1": 1.10,
    "ca-west-1": 1.15,
    "sa-east-1": 1.25,
    "eu-west-1": 1.08,
    "eu-west-2": 1.10,
    "eu-west-3": 1.08,
    "eu-central-1": 1.08,
    "eu-central-2": 1.12,
    "eu-north-1": 1.08,
    "eu-south-1": 1.15,
    "eu-south-2": 1.10,
    "ap-south-1": 1.09,
    "ap-south-2": 1.12,
    "ap-east-1": 1.25,
    "ap-northeast-1": 1.12,
    "ap-northeast-2": 1.15,
    "ap-northeast-3": 1.12,
    "ap-southeast-1": 1.12,
    "ap-southeast-2": 1.15,
    "ap-southeast-3": 1.15,
    "ap-southeast-4": 1.20,
    "ap-southeast-5": 1.15,
    "ap-southeast-6": 1.12,
    "ap-southeast-7": 1.15,
    "me-south-1": 1.20,
    "me-central-1": 1.15,
    "me-central-2": 1.12,
    "af-south-1": 1.35,
    "il-central-1": 1.20,
    "mx-central-1": 1.15,
}

# us-east-1-equivalent baseline rates, USD per month (representative snapshot).
# - gp3 includes 3000 IOPS and 125 MB/s; extras are billed per unit.
# - io1/io2 bill every provisioned IOPS (io2's real pricing is tiered;
#   simplified here for the spike).
# - gp2/st1/sc1 price storage only.
_RATES: dict[str, dict[str, float]] = {
    "gp2": {"storage_per_gb": 0.100},
    "gp3": {
        "storage_per_gb": 0.080,
        "iops_included": 3000,
        "iops_per_unit": 0.005,
        "thpt_included_mbps": 125,
        "thpt_per_mbps": 0.040,
    },
    "io1": {"storage_per_gb": 0.125, "iops_per_unit": 0.065},
    "io2": {"storage_per_gb": 0.065, "iops_per_unit": 0.065},
    "st1": {"storage_per_gb": 0.045},
    "sc1": {"storage_per_gb": 0.015},
}

_MAX_VOLUME_GB = 16384  # 16 TiB
_MAX_IOPS = 256000
_MAX_THROUGHPUT_MBPS = 4000
_MAX_REPEAT = 200


@dataclasses.dataclass(frozen=True)
class EbsInputs:
    """Validated request inputs for the EBS pricing calc."""

    size_gb: int
    iops: int | None = None
    throughput_mbps: int | None = None
    repeat: int = 1
    regions: tuple[str, ...] = EBS_REGIONS

    def as_dict(self) -> dict:
        data = dataclasses.asdict(self)
        data["regions"] = list(self.regions)
        return data


def _coerce_number(name: str, raw: object) -> int:
    if isinstance(raw, float):
        if not raw.is_integer():
            raise ValueError(f"{name} must be an integer")
        return int(raw)
    text = str(raw).strip()
    if not text:
        raise ValueError(f"{name} must be an integer")
    try:
        return int(text)
    except ValueError:
        try:
            return _coerce_number(name, float(text))
        except ValueError:
            raise ValueError(f"{name} must be an integer") from None


def _parse_int(values: Mapping, name: str, default: int | None, lo: int, hi: int) -> int | None:
    raw = values.get(name, default)
    if raw is None:
        return None
    if isinstance(raw, bool):
        raise ValueError(f"{name} must be an integer")
    number = raw if isinstance(raw, int) else _coerce_number(name, raw)
    if number < lo or number > hi:
        raise ValueError(f"{name} must be between {lo} and {hi}")
    return number


def _parse_regions(values: Mapping) -> tuple[str, ...]:
    raw = values.get("regions")
    if raw is None:
        return EBS_REGIONS
    if isinstance(raw, str):
        requested = tuple(item.strip() for item in raw.split(","))
    elif isinstance(raw, (list, tuple)):
        requested = tuple(str(item).strip() for item in raw)
    else:
        raise ValueError("regions must be a comma-separated string or a list")
    requested = tuple(item for item in requested if item)
    unknown = [region for region in requested if region not in EBS_REGIONS]
    if unknown:
        raise ValueError(f"unknown regions: {', '.join(unknown)}")
    if not requested:
        raise ValueError("regions cannot be empty")
    return requested


def parse_ebs_inputs(values: Mapping[str, object]) -> EbsInputs:
    """Build validated EbsInputs from query params or a JSON body.

    Raises ValueError with a user-facing message on invalid input.
    """
    size_gb = _parse_int(values, "size_gb", 100, 1, _MAX_VOLUME_GB)
    iops = _parse_int(values, "iops", None, 0, _MAX_IOPS)
    throughput_mbps = _parse_int(values, "throughput_mbps", None, 0, _MAX_THROUGHPUT_MBPS)
    repeat = _parse_int(values, "repeat", 1, 1, _MAX_REPEAT)
    regions = _parse_regions(values)
    return EbsInputs(
        size_gb=size_gb,
        iops=iops,
        throughput_mbps=throughput_mbps,
        repeat=repeat,
        regions=regions,
    )


def line_item(
    volume_type: str,
    region: str,
    size_gb: int,
    iops: int | None,
    throughput_mbps: int | None,
) -> dict:
    """Monthly cost of one (volume type, region) combination, USD."""
    multiplier = _REGION_MULTIPLIER[region]
    rates = _RATES[volume_type]
    storage = size_gb * rates["storage_per_gb"] * multiplier
    iops_cost = 0.0
    thpt_cost = 0.0
    note = None
    if volume_type == "gp3":
        if iops is not None and iops > rates["iops_included"]:
            iops_cost = (iops - rates["iops_included"]) * rates["iops_per_unit"] * multiplier
        if throughput_mbps is not None and throughput_mbps > rates["thpt_included_mbps"]:
            thpt_cost = (
                (throughput_mbps - rates["thpt_included_mbps"])
                * rates["thpt_per_mbps"]
                * multiplier
            )
    elif volume_type in ("io1", "io2"):
        iops_cost = (iops or 0) * rates["iops_per_unit"] * multiplier
    elif iops is not None or throughput_mbps is not None:
        # gp2, st1, sc1 price storage only; given params are ignored.
        note = "provisioned iops/throughput not supported for this volume type"
    item = {
        "storage_usd": round(storage, 4),
        "iops_usd": round(iops_cost, 4),
        "throughput_usd": round(thpt_cost, 4),
        "total_usd": round(storage + iops_cost + thpt_cost, 4),
    }
    if note is not None:
        item["note"] = note
    return item


def compute_ebs_matrix(inputs: EbsInputs) -> dict:
    """Price the inputs across every requested region and volume type.

    `inputs.repeat` re-runs the whole matrix computation and keeps only the
    final result. That makes this endpoint the CPU probe for the Phase 0
    decision rule (does server-side math fit the free plan 10 ms CPU budget?)
    without changing what the response means.
    """
    matrix: dict[str, dict[str, dict]] = {}
    totals: dict[str, float] = {}
    for _ in range(inputs.repeat):
        matrix = {}
        totals = {
            "storage_usd": 0.0,
            "iops_usd": 0.0,
            "throughput_usd": 0.0,
            "grand_usd": 0.0,
        }
        for volume_type in EBS_VOLUME_TYPES:
            per_region: dict[str, dict] = {}
            for region in inputs.regions:
                item = line_item(
                    volume_type, region, inputs.size_gb, inputs.iops, inputs.throughput_mbps
                )
                per_region[region] = item
                for component in ("storage_usd", "iops_usd", "throughput_usd"):
                    totals[component] += item[component]
                totals["grand_usd"] += item["total_usd"]
            matrix[volume_type] = per_region
    return {
        "matrix": matrix,
        "totals": {key: round(value, 4) for key, value in totals.items()},
        "line_items": len(EBS_VOLUME_TYPES) * len(inputs.regions),
        "iterations": inputs.repeat,
    }
