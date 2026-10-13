import { describe, expect, it } from "vitest";

import { cfSummary, clientIpFromHeaders, ipVersion, UNKNOWN_IP, type HeaderLookup } from "../src/tools/ip.ts";

const lookup =
  (values: Record<string, string>): HeaderLookup =>
  (name: string) =>
    values[name];

describe("clientIpFromHeaders", () => {
  it("prefers cf-connecting-ip", () => {
    const header = lookup({
      "cf-connecting-ip": "203.0.113.7",
      "x-forwarded-for": "198.51.100.9",
    });
    expect(clientIpFromHeaders(header)).toBe("203.0.113.7");
  });

  it("falls back to the first x-forwarded-for hop", () => {
    const header = lookup({ "x-forwarded-for": "198.51.100.9, 10.0.0.1" });
    expect(clientIpFromHeaders(header)).toBe("198.51.100.9");
  });

  it("strips whitespace", () => {
    const header = lookup({ "cf-connecting-ip": "  1.2.3.4  " });
    expect(clientIpFromHeaders(header)).toBe("1.2.3.4");
  });

  it("returns unknown when no headers are present", () => {
    expect(clientIpFromHeaders(lookup({}))).toBe(UNKNOWN_IP);
  });

  it("skips empty values", () => {
    const header = lookup({ "cf-connecting-ip": "", "true-client-ip": "5.6.7.8" });
    expect(clientIpFromHeaders(header)).toBe("5.6.7.8");
  });
});

describe("ipVersion", () => {
  it("detects IPv4", () => {
    expect(ipVersion("1.2.3.4")).toBe(4);
  });

  it("detects IPv6", () => {
    expect(ipVersion("2001:db8::1")).toBe(6);
  });

  it("returns null for non-addresses", () => {
    expect(ipVersion("unknown")).toBeNull();
  });
});

describe("cfSummary", () => {
  it("returns nulls when cf is absent", () => {
    const summary = cfSummary(undefined);
    expect(summary["country"]).toBeNull();
    expect(summary["colo"]).toBeNull();
  });

  it("maps the known fields to snake_case", () => {
    const summary = cfSummary({
      country: "US",
      city: "Miami",
      region: "Florida",
      colo: "MIA",
      asn: 7922,
      asOrganization: "Comcast",
      timezone: "America/New_York",
    });
    expect(summary).toEqual({
      country: "US",
      city: "Miami",
      region: "Florida",
      colo: "MIA",
      asn: 7922,
      as_organization: "Comcast",
      timezone: "America/New_York",
    });
  });

  it("keeps absent fields as null", () => {
    const summary = cfSummary({ colo: "MIA" });
    expect(summary["city"]).toBeNull();
    expect(summary["colo"]).toBe("MIA");
  });
});
