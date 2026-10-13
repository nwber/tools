"""Unit tests for the pure /ip helpers (src/ipx.py)."""

from ipx import cf_summary, client_ip_from_headers, ip_version


class TestClientIp:
    def test_prefers_cf_connecting_ip(self):
        headers = {"cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.9"}
        assert client_ip_from_headers(headers) == "203.0.113.7"

    def test_falls_back_to_first_xff_hop(self):
        headers = {"x-forwarded-for": "198.51.100.9, 10.0.0.1"}
        assert client_ip_from_headers(headers) == "198.51.100.9"

    def test_strips_whitespace(self):
        assert client_ip_from_headers({"cf-connecting-ip": "  1.2.3.4  "}) == "1.2.3.4"

    def test_no_headers_yields_unknown(self):
        assert client_ip_from_headers({}) == "unknown"

    def test_empty_values_skipped(self):
        headers = {"cf-connecting-ip": "", "true-client-ip": "5.6.7.8"}
        assert client_ip_from_headers(headers) == "5.6.7.8"


class TestIpVersion:
    def test_ipv4(self):
        assert ip_version("1.2.3.4") == 4

    def test_ipv6(self):
        assert ip_version("2001:db8::1") == 6

    def test_unknown_string(self):
        assert ip_version("unknown") is None


class TestCfSummary:
    def test_none_cf(self):
        summary = cf_summary(None)
        assert summary["country"] is None
        assert summary["colo"] is None

    def test_extracts_known_fields(self):
        summary = cf_summary(
            {
                "country": "US",
                "city": "Miami",
                "region": "Florida",
                "colo": "MIA",
                "asn": 7922,
                "asOrganization": "Comcast",
                "timezone": "America/New_York",
            }
        )
        assert summary == {
            "country": "US",
            "city": "Miami",
            "region": "Florida",
            "colo": "MIA",
            "asn": 7922,
            "as_organization": "Comcast",
            "timezone": "America/New_York",
        }

    def test_empty_strings_become_none(self):
        summary = cf_summary({"city": "", "colo": "MIA"})
        assert summary["city"] is None
        assert summary["colo"] == "MIA"
