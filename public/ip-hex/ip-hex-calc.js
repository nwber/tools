/**
 * Pure conversion math for the IP <-> hex page (unit-tested with vitest; DOM
 * wiring lives in ip-hex-page.js).
 *
 * One entry point, convert(), accepts the shapes a user is likely to paste:
 *
 *   - an IPv4 literal ("192.168.1.1") or IPv6 literal ("2001:db8::1",
 *     "::ffff:192.168.1.1"); an optional [..] wrapper and a %zone suffix
 *     are dropped (neither has a representation in hex);
 *   - a hex string: "c0a80101", "0xc0a80101", "c0.a8.01.01", "c0a8 0101",
 *     with a per-component 0x prefix allowed. Up to 8 digits read as a
 *     32-bit IPv4 address ("0x1" is 0.0.0.1), up to 32 as an IPv6 address;
 *   - a decimal integer ("3232235777") that is not exactly 8 or 32 digits —
 *     those lengths stay hex, so "c0a80101" keeps meaning 192.168.1.1. An
 *     all-digit input is readable both ways; results report `ambiguous`, and
 *     `convert(input, {readAs: "hex" | "decimal"})` forces either reading.
 *
 * Text output is lowercase; IPv6 uses RFC 5952 canonical compression.
 */

/** Hex digits in a 32-bit IPv4 address. */
export const IPV4_HEX_DIGITS = 8;
/** Hex digits in a 128-bit IPv6 address. */
export const IPV6_HEX_DIGITS = 32;

const isByte = (part) => /^\d{1,3}$/.test(part) && Number(part) <= 255;

/**
 * Parse a dotted-quad IPv4 literal into 4 bytes, or null. Leading zeros in
 * octets are accepted ("192.168.001.001"), anything non-decimal is not.
 */
export function parseIpv4(text) {
  const parts = text.trim().split(".");
  if (parts.length !== 4 || !parts.every(isByte)) return null;
  return Uint8Array.from(parts, Number);
}

/**
 * Parse an IPv6 literal into 16 bytes, or null. Handles "::" compression
 * (once), an embedded trailing dotted quad, an [..] bracket wrapper, and a
 * %zone suffix. Returns null — rather than throwing — on anything malformed.
 */
export function parseIpv6(text) {
  let input = text.trim();
  if (input.startsWith("[") && input.endsWith("]")) input = input.slice(1, -1);
  const zone = input.indexOf("%");
  if (zone !== -1) input = input.slice(0, zone);
  if (!input.includes(":")) return null;

  // A trailing dotted quad (::ffff:192.168.1.1) is two 16-bit groups.
  let head = input;
  const tailGroups = [];
  const lastColon = input.lastIndexOf(":");
  const afterLast = input.slice(lastColon + 1);
  if (afterLast.includes(".")) {
    const quad = parseIpv4(afterLast);
    if (quad === null) return null;
    tailGroups.push(((quad[0] << 8) | quad[1]).toString(16), ((quad[2] << 8) | quad[3]).toString(16));
    // Keep the full "::" when the quad directly follows it: "::192.168.1.1".
    head = input[lastColon - 1] === ":" ? input.slice(0, lastColon + 1) : input.slice(0, lastColon);
  }

  let groups;
  const compression = head.indexOf("::");
  if (compression === -1) {
    groups = head === "" ? [] : head.split(":");
    groups.push(...tailGroups);
  } else {
    if (head.indexOf("::", compression + 1) !== -1) return null; // one "::" only
    const left = head.slice(0, compression);
    const right = head.slice(compression + 2);
    const leftGroups = left === "" ? [] : left.split(":");
    const rightGroups = right === "" ? [] : right.split(":");
    const zeros = 8 - leftGroups.length - rightGroups.length - tailGroups.length;
    if (zeros < 1) return null; // "::" must stand for at least one group
    groups = [...leftGroups, ...Array(zeros).fill("0"), ...rightGroups, ...tailGroups];
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    if (!/^[0-9a-f]{1,4}$/i.test(groups[i])) return null;
    const value = parseInt(groups[i], 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

/** Parse either IP version, or null. Returns {version, bytes}. */
export function parseIp(text) {
  const v4 = parseIpv4(text);
  if (v4 !== null) return { version: 4, bytes: v4 };
  const v6 = parseIpv6(text);
  if (v6 !== null) return { version: 6, bytes: v6 };
  return null;
}

/** Dotted-quad form of a 4-byte address ("192.168.1.1"). */
export function formatIpv4(bytes) {
  return Array.from(bytes).join(".");
}

/**
 * RFC 5952 canonical IPv6 text: lowercase, longest zero run compressed once.
 * IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) addresses use
 * the mixed dotted-quad form instead, which is how they are read.
 */
export function formatIpv6(bytes) {
  const quad = embeddedIpv4(bytes);
  if (quad !== null) {
    return bytes[10] === 0xff && bytes[11] === 0xff ? `::ffff:${quad}` : `::${quad}`;
  }

  const groups = [];
  for (let i = 0; i < 8; i += 1) {
    groups.push(((bytes[i * 2] << 8) | bytes[i * 2 + 1]).toString(16));
  }

  // First longest run of two or more zero groups wins.
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  let runLength = 0;
  for (let i = 0; i <= 8; i += 1) {
    if (i < 8 && bytes[i * 2] === 0 && bytes[i * 2 + 1] === 0) {
      if (runStart === -1) runStart = i;
      runLength += 1;
    } else {
      if (runLength > bestLength) {
        bestStart = runStart;
        bestLength = runLength;
      }
      runStart = -1;
      runLength = 0;
    }
  }
  if (bestLength > 1) {
    const left = groups.slice(0, bestStart).join(":");
    const right = groups.slice(bestStart + bestLength).join(":");
    return `${left}::${right}`;
  }
  return groups.join(":");
}

/** Full 8-group, 4-digit-per-group IPv6 text ("2001:0db8:0000:...:0001"). */
export function formatIpv6Expanded(bytes) {
  const groups = [];
  for (let i = 0; i < 8; i += 1) {
    groups.push(((bytes[i * 2] << 8) | bytes[i * 2 + 1]).toString(16).padStart(4, "0"));
  }
  return groups.join(":");
}

/**
 * The IPv4 address an IPv6 address carries when it is IPv4-mapped
 * (::ffff:a.b.c.d) or IPv4-compatible (::a.b.c.d), dotted form; null
 * otherwise. The unspecified (::) and loopback (::1) addresses are not
 * reported as embedded IPv4 — historically compatible, but never read
 * that way.
 */
export function embeddedIpv4(bytes) {
  if (!bytes.slice(0, 10).every((byte) => byte === 0)) return null;
  const mapped = bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return formatIpv4(bytes.slice(12));
  if (bytes[10] !== 0 || bytes[11] !== 0) return null; // compat form only
  const last = Array.from(bytes.slice(12));
  if (last.every((byte) => byte === 0)) return null; // ::
  if (last[0] === 0 && last[1] === 0 && last[2] === 0 && last[3] === 1) return null; // ::1
  return formatIpv4(bytes.slice(12));
}

/** Lowercase hex for a byte array, two digits per byte. */
export function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Normalize a hex string to lowercase digits with no prefixes or separators,
 * or null if it is not hex at all. Accepts an optional 0x/0X prefix (per
 * dot/space/underscore-separated component too) so "0xc0 0xa8 0x01 0x01",
 * "c0.a8.01.01", and "c0a80101" all normalize alike.
 */
export function normalizeHex(text) {
  const parts = text.trim().split(/[.\s_]+/);
  let digits = "";
  for (const part of parts) {
    const bare = part.replace(/^0x/i, "");
    if (!/^[0-9a-f]+$/i.test(bare)) return null;
    digits += bare;
  }
  return digits === "" ? null : digits.toLowerCase();
}

function hexToBytes(hex, width) {
  const padded = hex.padStart(width, "0");
  const bytes = new Uint8Array(width / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToBigInt(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** Every representation the page shows for one address. */
function addressResult(source, version, bytes) {
  const hex = bytesToHex(bytes);
  return {
    ok: true,
    source, // "ip" | "hex" | "decimal"
    version, // 4 | 6
    ip: version === 4 ? formatIpv4(bytes) : formatIpv6(bytes),
    expanded: version === 4 ? null : formatIpv6Expanded(bytes),
    hex,
    hex0x: `0x${hex}`,
    hexDotted: version === 4 ? (hex.match(/../g) ?? []).join(".") : null,
    decimal: bytesToBigInt(bytes).toString(),
    mappedIpv6: version === 4 ? `::ffff:${formatIpv4(bytes)}` : null,
    mappedIpv4: version === 6 ? embeddedIpv4(bytes) : null,
    // Digit-only input can be read as hex or decimal; set by convert().
    ambiguous: false,
    readAs: null,
  };
}

const fail = (error) => ({ ok: false, error });

/**
 * Convert one input into all of its representations. Never throws: invalid
 * input comes back as {ok: false, error}, intended for display as-is.
 *
 * `options.readAs` forces the reading of digit-only input ("hex"/"decimal");
 * without it, exactly an 8- or 32-digit string is read as hex and everything
 * else as decimal. A successful result reports `ambiguous` (both readings are
 * valid) and which reading was used in `readAs`, so a UI can offer the other
 * one.
 */
export function convert(rawInput, options = {}) {
  const input = String(rawInput ?? "").trim();
  const force =
    options.readAs === "hex" || options.readAs === "decimal" ? options.readAs : null;
  if (input === "") {
    return fail("enter an IP address, a hex string, or a decimal integer");
  }

  const ip = parseIp(input);
  if (ip !== null) return addressResult("ip", ip.version, ip.bytes);

  // Dotted-decimal and colon-separated input is clearly aiming at an IP
  // literal; a typo there should say so instead of falling through to hex.
  if (input.includes(".") && /^[0-9.]+$/.test(input)) {
    return fail("not a valid IPv4 address — need four octets, each 0-255");
  }
  if (input.includes(":")) {
    return fail("not a valid IPv6 address — need eight hex groups or one :: compression");
  }

  if (/^[0-9]+$/.test(input)) {
    const digitCount = input.length;
    const readAs =
      force ??
      (digitCount === IPV4_HEX_DIGITS || digitCount === IPV6_HEX_DIGITS ? "hex" : "decimal");
    // Both readings are valid whenever the digits also fit 32 hex digits
    // (and 10^32 < 2^128, so any such decimal is a valid IPv6 value too).
    const ambiguous = digitCount <= IPV6_HEX_DIGITS;

    if (readAs === "hex") {
      if (digitCount > IPV6_HEX_DIGITS) {
        return fail(`too many hex digits (${digitCount}) — an IPv6 address is at most ${IPV6_HEX_DIGITS}`);
      }
      const version = digitCount <= IPV4_HEX_DIGITS ? 4 : 6;
      const bytes = hexToBytes(input, version === 4 ? IPV4_HEX_DIGITS : IPV6_HEX_DIGITS);
      return { ...addressResult("hex", version, bytes), ambiguous, readAs: "hex" };
    }

    if (digitCount > 39) {
      return fail("decimal value exceeds 128 bits, the largest IPv6 address");
    }
    const value = BigInt(input);
    if (value > 2n ** 128n - 1n) {
      return fail("decimal value exceeds 128 bits, the largest IPv6 address");
    }
    const bytes = new Uint8Array(16);
    for (let i = 15; i >= 0; i -= 1) {
      bytes[i] = Number(value >> BigInt((15 - i) * 8) & 0xffn);
    }
    const result =
      value <= 0xffffffffn
        ? addressResult("decimal", 4, bytes.slice(12))
        : addressResult("decimal", 6, bytes);
    return { ...result, ambiguous, readAs: "decimal" };
  }

  const hex = normalizeHex(input);
  if (hex === null) {
    return fail("not an IP address, hex string, or decimal integer — hex digits are 0-9a-f with an optional 0x prefix");
  }
  if (hex.length > IPV6_HEX_DIGITS) {
    return fail(`too many hex digits (${hex.length}) — an IPv6 address is at most ${IPV6_HEX_DIGITS}`);
  }
  const version = hex.length <= IPV4_HEX_DIGITS ? 4 : 6;
  return addressResult("hex", version, hexToBytes(hex, version === 4 ? IPV4_HEX_DIGITS : IPV6_HEX_DIGITS));
}
