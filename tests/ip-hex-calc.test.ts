/**
 * Tests for the IP <-> hex converter: the pure conversion module
 * (public/ip-hex/ip-hex-calc.js) that backs the /ip-hex/ page.
 */

import { describe, expect, it } from "vitest";

import {
  bytesToHex,
  convert,
  embeddedIpv4,
  formatIpv4,
  formatIpv6,
  formatIpv6Expanded,
  normalizeHex,
  parseIp,
  parseIpv4,
  parseIpv6,
} from "../public/ip-hex/ip-hex-calc.js";

const bytes = (result: Uint8Array | null) => (result === null ? null : Array.from(result));

type ReadAs = "hex" | "decimal";

type Address = {
  ok: true;
  source: "ip" | "hex" | "decimal";
  version: 4 | 6;
  ip: string;
  expanded: string | null;
  hex: string;
  hex0x: string;
  hexDotted: string | null;
  decimal: string;
  mappedIpv6: string | null;
  mappedIpv4: string | null;
  ambiguous: boolean;
  readAs: ReadAs | null;
};

/** convert() asserting success, for tests that read the result's fields. */
function ok(text: string, options?: { readAs: ReadAs }): Address {
  const result = convert(text, options) as Address | { ok: false; error: string };
  if (!result.ok) throw new Error(`${text}: ${result.error}`);
  return result;
}

describe("parseIpv4", () => {
  it("parses dotted quads", () => {
    expect(bytes(parseIpv4("192.168.1.1"))).toEqual([192, 168, 1, 1]);
    expect(bytes(parseIpv4("0.0.0.0"))).toEqual([0, 0, 0, 0]);
    expect(bytes(parseIpv4("255.255.255.255"))).toEqual([255, 255, 255, 255]);
  });

  it("accepts leading zeros and surrounding whitespace", () => {
    expect(bytes(parseIpv4(" 192.168.001.001 "))).toEqual([192, 168, 1, 1]);
  });

  it("rejects malformed or out-of-range quads", () => {
    for (const bad of ["256.1.1.1", "1.2.3", "1.2.3.4.5", "1.2.3.4.", "", "1.2.3.-4", "a.b.c.d"]) {
      expect(parseIpv4(bad), bad).toBeNull();
    }
  });
});

describe("parseIpv6", () => {
  it("parses a full uncompressed address", () => {
    expect(bytes(parseIpv6("2001:0db8:85a3:0000:0000:8a2e:0370:7334"))).toEqual([
      0x20, 0x01, 0x0d, 0xb8, 0x85, 0xa3, 0x00, 0x00, 0x00, 0x00, 0x8a, 0x2e, 0x03, 0x70, 0x73,
      0x34,
    ]);
  });

  it("parses :: compression in any position", () => {
    const expected = bytes(parseIpv6("2001:0db8:85a3:0000:0000:8a2e:0370:7334"));
    expect(bytes(parseIpv6("2001:db8:85a3::8a2e:370:7334"))).toEqual(expected);
    expect(bytes(parseIpv6("::8a2e:370:7334"))).not.toBeNull();
    expect(bytes(parseIpv6("2001:db8:85a3::"))).not.toBeNull();
    expect(bytes(parseIpv6("::1"))).toEqual([...Array(15).fill(0), 1]);
    expect(bytes(parseIpv6("::"))).toEqual(Array(16).fill(0));
  });

  it("parses an embedded trailing dotted quad", () => {
    const mapped = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 192, 168, 1, 1];
    expect(bytes(parseIpv6("::ffff:192.168.1.1"))).toEqual(mapped);
    expect(bytes(parseIpv6("0:0:0:0:0:ffff:192.168.1.1"))).toEqual(mapped);
    expect(bytes(parseIpv6("::192.168.1.1"))).toEqual([...Array(12).fill(0), 192, 168, 1, 1]);
  });

  it("accepts uppercase and strips [..] wrappers and %zones", () => {
    expect(bytes(parseIpv6("2001:DB8::1"))).toEqual(bytes(parseIpv6("2001:db8::1")));
    expect(bytes(parseIpv6("[2001:db8::1]"))).toEqual(bytes(parseIpv6("2001:db8::1")));
    expect(bytes(parseIpv6("fe80::1%eth0"))).toEqual(bytes(parseIpv6("fe80::1")));
    expect(bytes(parseIpv6("[fe80::1%eth0]"))).toEqual(bytes(parseIpv6("fe80::1")));
  });

  it("rejects malformed addresses", () => {
    for (const bad of [
      "2001:db8:::1", // three colons
      "2001:db8::1::2", // two compressions
      "2001:db8:0:0:0:0:0:0:1", // nine groups
      "1:2:3:4:5:6:7", // seven groups, no compression
      "12345::", // group too long
      "g123::1", // non-hex group
      "::ffff:999.1.1.1", // bad embedded quad
      "::ffff:1.2.3", // short embedded quad
      "192.168.1.1::", // quad outside the tail
      "no colons here",
      "",
    ]) {
      expect(parseIpv6(bad), bad).toBeNull();
    }
  });
});

describe("parseIp", () => {
  it("detects the version", () => {
    expect(parseIp("10.0.0.1")).toMatchObject({ version: 4 });
    expect(parseIp("::ffff:10.0.0.1")).toMatchObject({ version: 6 });
    expect(parseIp("not an address")).toBeNull();
  });
});

describe("formatIpv4 / bytesToHex", () => {
  it("formats dotted quads and lowercase hex", () => {
    expect(formatIpv4(Uint8Array.from([10, 0, 0, 255]))).toBe("10.0.0.255");
    expect(bytesToHex(Uint8Array.from([0, 15, 16, 255]))).toBe("000f10ff");
  });
});

describe("formatIpv6", () => {
  const format = (text: string) => formatIpv6(parseIpv6(text) as Uint8Array);

  it("compresses the longest zero run and strips leading zeros", () => {
    expect(format("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
    expect(format("0000:0000:0000:0000:0000:0000:0000:0000")).toBe("::");
    expect(format("0000:0000:0000:0000:0000:0000:0000:0001")).toBe("::1");
    expect(format("2001:0db8:0000:0000:0000:0000:0000:0000")).toBe("2001:db8::");
  });

  it("compresses only runs of two or more", () => {
    expect(format("2001:db8:0:1:1:1:1:1")).toBe("2001:db8:0:1:1:1:1:1");
  });

  it("compresses the first of equally long runs", () => {
    expect(format("2001:0:0:1:0:0:2:1")).toBe("2001::1:0:0:2:1");
    expect(format("1:0:2:0:0:3:4:5")).toBe("1:0:2::3:4:5");
  });

  it("uses the mixed dotted form for IPv4-mapped and -compatible addresses", () => {
    expect(format("::ffff:192.168.1.1")).toBe("::ffff:192.168.1.1");
    expect(format("::192.168.1.1")).toBe("::192.168.1.1");
    // Not in ::ffff:0:0/96 or ::/96 — stays pure IPv6 text.
    expect(format("64:ff9b::ffff:c000:221")).toBe("64:ff9b::ffff:c000:221");
  });
});

describe("formatIpv6Expanded", () => {
  it("always writes eight 4-digit groups", () => {
    expect(formatIpv6Expanded(parseIpv6("2001:db8::1") as Uint8Array)).toBe(
      "2001:0db8:0000:0000:0000:0000:0000:0001",
    );
    expect(formatIpv6Expanded(parseIpv6("::") as Uint8Array)).toBe(
      "0000:0000:0000:0000:0000:0000:0000:0000",
    );
  });
});

describe("embeddedIpv4", () => {
  const embedded = (text: string) => embeddedIpv4(parseIpv6(text) as Uint8Array);

  it("reports mapped and compatible addresses", () => {
    expect(embedded("::ffff:192.168.1.1")).toBe("192.168.1.1");
    expect(embedded("::192.168.1.1")).toBe("192.168.1.1");
  });

  it("does not report :: or ::1 or non-zero prefixes", () => {
    expect(embedded("::")).toBeNull();
    expect(embedded("::1")).toBeNull();
    expect(embedded("64:ff9b::ffff:c000:221")).toBeNull();
    expect(embedded("2001:db8::1")).toBeNull();
  });
});

describe("normalizeHex", () => {
  it("accepts bare, 0x, dotted, and spaced hex", () => {
    expect(normalizeHex("c0a80101")).toBe("c0a80101");
    expect(normalizeHex("0xC0A80101")).toBe("c0a80101");
    expect(normalizeHex("c0.a8.01.01")).toBe("c0a80101");
    expect(normalizeHex("0xc0 0xa8 0x01 0x01")).toBe("c0a80101");
    expect(normalizeHex("c0_a8_0101")).toBe("c0a80101");
  });

  it("rejects anything that is not hex", () => {
    for (const bad of ["", "0x", "c0g80101", "0x 10", "hello"]) {
      expect(normalizeHex(bad), bad).toBeNull();
    }
  });
});

describe("convert: IP input", () => {
  it("converts IPv4 to every representation", () => {
    expect(convert("192.168.1.1")).toEqual({
      ok: true,
      source: "ip",
      version: 4,
      ip: "192.168.1.1",
      expanded: null,
      hex: "c0a80101",
      hex0x: "0xc0a80101",
      hexDotted: "c0.a8.01.01",
      decimal: "3232235777",
      mappedIpv6: "::ffff:192.168.1.1",
      mappedIpv4: null,
      ambiguous: false,
      readAs: null,
    });
  });

  it("converts IPv6 to every representation", () => {
    const result = convert("2001:db8::1");
    expect(result).toMatchObject({
      ok: true,
      source: "ip",
      version: 6,
      ip: "2001:db8::1",
      expanded: "2001:0db8:0000:0000:0000:0000:0000:0001",
      hex: "20010db8000000000000000000000001",
      hex0x: "0x20010db8000000000000000000000001",
      hexDotted: null,
      decimal: "42540766411282592856903984951653826561",
      mappedIpv6: null,
      mappedIpv4: null,
    });
  });

  it("reports the embedded IPv4 of a mapped address", () => {
    const result = convert("::ffff:192.168.1.1");
    expect(result).toMatchObject({
      version: 6,
      ip: "::ffff:192.168.1.1",
      hex: "00000000000000000000ffffc0a80101",
      mappedIpv4: "192.168.1.1",
    });
  });

  it("keeps the unspecified and loopback addresses free of embedded IPv4", () => {
    expect(convert("::")).toMatchObject({ ip: "::", mappedIpv4: null });
    expect(convert("::1")).toMatchObject({ ip: "::1", mappedIpv4: null });
  });

  it("accepts uppercase, brackets, and zones", () => {
    expect(convert("2001:DB8::1")).toMatchObject({ ok: true, ip: "2001:db8::1" });
    expect(convert("[fe80::1%eth0]")).toMatchObject({ ok: true, ip: "fe80::1" });
  });
});

describe("convert: hex input", () => {
  const asIpv4 = {
    ok: true,
    source: "hex",
    version: 4,
    ip: "192.168.1.1",
    expanded: null,
    hex: "c0a80101",
    hex0x: "0xc0a80101",
    hexDotted: "c0.a8.01.01",
    decimal: "3232235777",
    mappedIpv6: "::ffff:192.168.1.1",
    mappedIpv4: null,
    ambiguous: false,
    readAs: null,
  };

  it("reads up to 8 digits as a 32-bit IPv4 address", () => {
    expect(convert("c0a80101")).toEqual(asIpv4);
    expect(convert("0xC0A80101")).toEqual(asIpv4);
    expect(convert("c0.a8.01.01")).toEqual(asIpv4);
    expect(convert("0xc0 0xa8 0x01 0x01")).toEqual(asIpv4);
  });

  it("left-pads short hex", () => {
    expect(convert("0x1")).toMatchObject({ version: 4, ip: "0.0.0.1", decimal: "1" });
    expect(convert("01020304")).toMatchObject({ version: 4, ip: "1.2.3.4" });
  });

  it("reads 9 to 32 digits as IPv6 when the hex reading is chosen", () => {
    expect(convert("123456789", { readAs: "hex" })).toMatchObject({
      source: "hex",
      version: 6,
      ip: "::1:2345:6789",
      hex: "00000000000000000000000123456789",
      ambiguous: true,
      readAs: "hex",
    });
    expect(convert("00000000000000000000000000000001")).toMatchObject({
      version: 6,
      ip: "::1",
      source: "hex",
      ambiguous: true,
      readAs: "hex",
    });
  });

  it("keeps pure-digit 8- and 32-digit strings as hex by default", () => {
    expect(convert("00000000")).toMatchObject({
      source: "hex",
      version: 4,
      ip: "0.0.0.0",
      ambiguous: true,
      readAs: "hex",
    });
    expect(convert("00000001")).toMatchObject({ source: "hex", version: 4, ip: "0.0.0.1" });
  });

  it("rejects hex wider than 128 bits", () => {
    expect(convert("0x" + "f".repeat(33))).toMatchObject({ ok: false });
    expect(convert("1".repeat(33), { readAs: "hex" })).toMatchObject({ ok: false });
  });
});

describe("convert: decimal input", () => {
  it("reads digit-only strings of other lengths as decimal", () => {
    expect(convert("3232235777")).toMatchObject({
      source: "decimal",
      version: 4,
      ip: "192.168.1.1",
      hex: "c0a80101",
      ambiguous: true,
      readAs: "decimal",
    });
    expect(convert("0")).toMatchObject({ version: 4, ip: "0.0.0.0", readAs: "decimal" });
    expect(convert("4294967295")).toMatchObject({ version: 4, ip: "255.255.255.255" });
    expect(convert("4294967296")).toMatchObject({ version: 6, ip: "::1:0:0" });
    expect(convert("340282366920938463463374607431768211455")).toMatchObject({
      version: 6,
      ip: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      ambiguous: false,
      readAs: "decimal",
    });
  });

  it("rejects values above 128 bits", () => {
    expect(convert("340282366920938463463374607431768211456")).toMatchObject({ ok: false });
  });

  it("reads 8/32-digit strings as decimal when asked to", () => {
    expect(convert("16909060", { readAs: "decimal" })).toMatchObject({
      source: "decimal",
      version: 4,
      ip: "1.2.3.4",
      ambiguous: true,
      readAs: "decimal",
    });
    expect(convert("3232235777")).toMatchObject({ version: 4, ip: "192.168.1.1" });
    expect(convert("12345678", { readAs: "decimal" })).toMatchObject({ version: 4, ip: "0.188.97.78" });
  });

  it("ignores the override for input that is not digit-only", () => {
    expect(convert("c0a80101", { readAs: "decimal" })).toMatchObject({
      source: "hex",
      ip: "192.168.1.1",
      ambiguous: false,
      readAs: null,
    });
    expect(convert("192.168.1.1", { readAs: "decimal" })).toMatchObject({ source: "ip" });
  });
});

describe("convert: round trips", () => {
  const addresses = [
    "0.0.0.0",
    "1.2.3.4",
    "10.20.30.40",
    "192.168.1.1",
    "255.255.255.255",
    "::",
    "::1",
    "2001:db8::1",
    "fe80::1",
    "2a00:1450:4001:80e::200e",
    "::ffff:192.168.1.1",
    "64:ff9b::c000:221",
  ];

  it("hex and 0x-hex convert back to the same address", () => {
    for (const address of addresses) {
      const first = ok(address);
      const viaHex = ok(first.hex);
      const viaHex0x = ok(first.hex0x);
      expect(viaHex, address).toMatchObject({ version: first.version, ip: first.ip });
      expect(viaHex0x, address).toMatchObject({ version: first.version, ip: first.ip });
    }
  });

  it("decimal converts back to the same address", () => {
    for (const address of addresses) {
      const first = ok(address);
      const viaDecimal = ok(first.decimal, { readAs: "decimal" });
      expect(viaDecimal.decimal, address).toBe(first.decimal);
      // A 128-bit value below 2^32 is indistinguishable from its 32-bit
      // form in decimal (:: prints as 0, which reads back as 0.0.0.0).
      if (first.version === 4 || BigInt(first.decimal) > 0xffffffffn) {
        expect(viaDecimal, address).toMatchObject({ version: first.version, ip: first.ip });
      }
    }
  });

  it("offers the other reading for ambiguous digit-only input", () => {
    for (const digits of ["16909060", "12345678", "123456789", "3232235777"]) {
      const asHex = ok(digits, { readAs: "hex" });
      const asDecimal = ok(digits, { readAs: "decimal" });
      expect(asHex, digits).toMatchObject({ ambiguous: true, readAs: "hex" });
      expect(asDecimal, digits).toMatchObject({ ambiguous: true, readAs: "decimal" });
      expect(ok(asHex.hex).ip, digits).toBe(asHex.ip); // hex stays the default at these widths
    }
  });
});

describe("convert: errors", () => {
  it("explains what went wrong", () => {
    expect(convert("")).toMatchObject({ ok: false, error: expect.stringContaining("enter") });
    expect(convert("1.2.3")).toMatchObject({ ok: false, error: expect.stringContaining("IPv4") });
    expect(convert("999.1.1.1")).toMatchObject({ ok: false, error: expect.stringContaining("octet") });
    expect(convert("2001:db8:::1")).toMatchObject({ ok: false, error: expect.stringContaining("IPv6") });
    expect(convert("hello world")).toMatchObject({ ok: false, error: expect.stringContaining("hex") });
    expect(convert("zz")).toMatchObject({ ok: false, error: expect.stringContaining("hex") });
  });

  it("trims surrounding whitespace", () => {
    expect(convert("  192.168.1.1\t")).toMatchObject({ ok: true, ip: "192.168.1.1" });
    expect(convert(null)).toMatchObject({ ok: false });
  });
});
