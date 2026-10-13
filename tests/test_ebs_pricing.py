"""Unit tests for the pure EBS pricing logic (src/ebs_pricing.py)."""

import pytest

from ebs_pricing import (
    EBS_REGIONS,
    EBS_VOLUME_TYPES,
    compute_ebs_matrix,
    line_item,
    parse_ebs_inputs,
)


class TestParseInputs:
    def test_defaults(self):
        inputs = parse_ebs_inputs({})
        assert inputs.size_gb == 100
        assert inputs.iops is None
        assert inputs.throughput_mbps is None
        assert inputs.repeat == 1
        assert inputs.regions == EBS_REGIONS

    def test_string_values(self):
        inputs = parse_ebs_inputs(
            {
                "size_gb": "512",
                "iops": "5000",
                "throughput_mbps": "300",
                "repeat": "3",
                "regions": "us-east-1, eu-west-1",
            }
        )
        assert inputs.size_gb == 512
        assert inputs.iops == 5000
        assert inputs.throughput_mbps == 300
        assert inputs.repeat == 3
        assert inputs.regions == ("us-east-1", "eu-west-1")

    def test_json_body_types(self):
        inputs = parse_ebs_inputs({"size_gb": 2048, "iops": 12000.0})
        assert inputs.size_gb == 2048
        assert inputs.iops == 12000

    def test_invalid_numbers(self):
        for bad in ("0", "16385", "abc", "-5"):
            with pytest.raises(ValueError):
                parse_ebs_inputs({"size_gb": bad})
        with pytest.raises(ValueError):
            parse_ebs_inputs({"iops": "-1"})
        with pytest.raises(ValueError):
            parse_ebs_inputs({"repeat": "201"})
        with pytest.raises(ValueError):
            parse_ebs_inputs({"throughput_mbps": "4001"})
        with pytest.raises(ValueError):
            parse_ebs_inputs({"size_gb": 100.5})

    def test_unknown_region(self):
        with pytest.raises(ValueError, match="mars-central-1"):
            parse_ebs_inputs({"regions": "us-east-1,mars-central-1"})

    def test_empty_regions(self):
        with pytest.raises(ValueError, match="cannot be empty"):
            parse_ebs_inputs({"regions": "  "})

    def test_as_dict_serializable(self):
        inputs = parse_ebs_inputs({"regions": "us-east-1"})
        data = inputs.as_dict()
        assert data["regions"] == ["us-east-1"]
        assert data["size_gb"] == 100


class TestLineItem:
    def test_gp2_storage_only(self):
        item = line_item("gp2", "us-east-1", 100, None, None)
        assert item == {
            "storage_usd": 10.0,
            "iops_usd": 0.0,
            "throughput_usd": 0.0,
            "total_usd": 10.0,
        }

    def test_gp3_charges_only_extras(self):
        item = line_item("gp3", "us-east-1", 100, 5000, 300)
        assert item["storage_usd"] == pytest.approx(8.0)
        assert item["iops_usd"] == pytest.approx((5000 - 3000) * 0.005)  # 10.0
        assert item["throughput_usd"] == pytest.approx((300 - 125) * 0.040)  # 7.0
        assert item["total_usd"] == pytest.approx(25.0)

    def test_gp3_within_allowance_bills_nothing_extra(self):
        item = line_item("gp3", "us-east-1", 100, 3000, 125)
        assert item["iops_usd"] == 0.0
        assert item["throughput_usd"] == 0.0
        assert item["total_usd"] == pytest.approx(8.0)

    def test_io1_bills_all_provisioned_iops(self):
        item = line_item("io1", "us-east-1", 100, 3000, None)
        assert item["storage_usd"] == pytest.approx(12.5)
        assert item["iops_usd"] == pytest.approx(3000 * 0.065)
        assert item["total_usd"] == pytest.approx(12.5 + 195.0)

    def test_io2_uses_lower_storage_rate(self):
        item = line_item("io2", "us-east-1", 100, None, None)
        assert item["storage_usd"] == pytest.approx(6.5)

    def test_unsupported_inputs_get_a_note(self):
        item = line_item("sc1", "us-east-1", 100, 3000, None)
        assert item["note"] == "provisioned iops/throughput not supported for this volume type"
        assert item["iops_usd"] == 0.0
        assert item["total_usd"] == pytest.approx(1.5)

    def test_region_multiplier_applies(self):
        item = line_item("gp2", "sa-east-1", 100, None, None)
        assert item["total_usd"] == pytest.approx(10.0 * 1.25)


class TestComputeMatrix:
    def test_covers_all_types_and_regions(self):
        result = compute_ebs_matrix(parse_ebs_inputs({}))
        assert result["line_items"] == len(EBS_VOLUME_TYPES) * len(EBS_REGIONS)
        assert result["iterations"] == 1
        for volume_type in EBS_VOLUME_TYPES:
            assert set(result["matrix"][volume_type]) == set(EBS_REGIONS)

    def test_totals_match_matrix(self):
        result = compute_ebs_matrix(parse_ebs_inputs({}))
        expected = sum(
            item["total_usd"]
            for per_region in result["matrix"].values()
            for item in per_region.values()
        )
        assert result["totals"]["grand_usd"] == pytest.approx(expected, abs=1e-6)

    def test_region_subset(self):
        inputs = parse_ebs_inputs({"regions": "us-east-1,eu-west-1"})
        result = compute_ebs_matrix(inputs)
        assert result["line_items"] == len(EBS_VOLUME_TYPES) * 2

    def test_repeat_reruns_deterministically(self):
        once = compute_ebs_matrix(parse_ebs_inputs({"repeat": "1"}))
        thrice = compute_ebs_matrix(parse_ebs_inputs({"repeat": "3"}))
        assert thrice["matrix"] == once["matrix"]
        assert thrice["totals"] == once["totals"]
        assert thrice["iterations"] == 3

    def test_iops_inputs_flow_through_matrix(self):
        inputs = parse_ebs_inputs({"regions": "us-east-1", "iops": "10000"})
        result = compute_ebs_matrix(inputs)
        gp3 = result["matrix"]["gp3"]["us-east-1"]
        assert gp3["iops_usd"] == pytest.approx((10000 - 3000) * 0.005)
        io1 = result["matrix"]["io1"]["us-east-1"]
        assert io1["iops_usd"] == pytest.approx(10000 * 0.065)
