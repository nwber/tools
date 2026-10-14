/**
 * In-process tests for the Worker's request handler.
 *
 * `HttpServerRequest.fromWeb` builds the same request the runtime hands to the
 * handler (including its host-stripped `url` and absolute `originalUrl`), so
 * these tests exercise real routing, response construction, and encoding —
 * the class of bug that a pure unit test on the helper modules would miss.
 */

import * as Effect from "effect/Effect";
import { HttpServerRequest, fromWeb } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { describe, expect, it } from "vitest";

import { fetchHandler } from "../src/handler.ts";

type Cf = {
  colo?: string;
  country?: string;
  city?: string;
  region?: string;
  asn?: number;
  asOrganization?: string;
  timezone?: string;
};

async function request(
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: RequestInit["body"]; cf?: Cf },
): Promise<{
  status: number;
  text: string;
  json: () => unknown;
  headers: Headers;
  arrayBuffer: () => Promise<ArrayBuffer>;
}> {
  const initOptions: RequestInit = {};
  if (init?.method !== undefined) initOptions.method = init.method;
  if (init?.headers !== undefined) initOptions.headers = init.headers;
  if (init?.body !== undefined) initOptions.body = init.body;
  const webRequest = new Request(`https://toolbox.nbergeron.dev${path}`, initOptions);
  if (init?.cf !== undefined) {
    Object.assign(webRequest, { cf: init.cf });
  }
  const serverRequest = fromWeb(webRequest);
  const response = await Effect.runPromise(
    fetchHandler.pipe(Effect.provideService(HttpServerRequest, serverRequest)),
  );
  const web = HttpServerResponse.toWeb(response);
  const buffer = await web.arrayBuffer();
  const text = new TextDecoder().decode(buffer);
  return {
    status: web.status,
    text,
    json: () => JSON.parse(text),
    headers: web.headers,
    arrayBuffer: async () => buffer,
  };
}

describe("fetch handler", () => {
  it("serves /ip as plain text from CF-Connecting-IP", async () => {
    const res = await request("/ip", { headers: { "cf-connecting-ip": "203.0.113.7" } });
    expect(res.status).toBe(200);
    expect(res.text).toBe("203.0.113.7\n");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("serves /ip with the query string present", async () => {
    const res = await request("/ip?cachebust=1", {
      headers: { "cf-connecting-ip": "198.51.100.9" },
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe("198.51.100.9\n");
  });

  it("serves /ip.json with cf geo data", async () => {
    const res = await request("/ip.json", {
      headers: { "cf-connecting-ip": "203.0.113.7" },
      cf: { colo: "MIA", country: "US", city: "Miami", asn: 7922, asOrganization: "Comcast" },
    });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({
      ip: "203.0.113.7",
      ip_version: 4,
      colo: "MIA",
      country: "US",
      city: "Miami",
      asn: 7922,
      as_organization: "Comcast",
      timezone: null,
    });
  });

  it("serves /api/health", async () => {
    const res = await request("/api/health", { cf: { colo: "BOS" } });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", service: "tools", phase: 4, colo: "BOS" });
  });

  it("answers HEAD like GET", async () => {
    const res = await request("/ip", {
      method: "HEAD",
      headers: { "cf-connecting-ip": "203.0.113.7" },
    });
    expect(res.status).toBe(200);
  });

  it("serves /api/ebs/pricing with the shared dataset", async () => {
    const res = await request("/api/ebs/pricing");
    expect(res.status).toBe(200);
    const body = res.json() as {
      regions: Record<string, string>;
      volumeTypes: Record<
        string,
        { durability: string; pricing: Record<string, { perGB: number }> }
      >;
    };
    // The recovered dataset has 23 regions and 7 volume types.
    expect(Object.keys(body.regions)).toHaveLength(23);
    expect(Object.keys(body.volumeTypes).sort()).toEqual([
      "gp2",
      "gp3",
      "io1",
      "io2",
      "sc1",
      "st1",
      "standard",
    ]);
    expect(body.volumeTypes["gp3"]?.pricing["us-east-1"]?.perGB).toBe(0.08);
    expect(body.volumeTypes["gp2"]?.durability).toBe("99.8%");
  });

  it("serves /api/ec2/burst-spec with the generated dataset", async () => {
    const res = await request("/api/ec2/burst-spec");
    expect(res.status).toBe(200);
    const body = res.json() as {
      sizes: Array<{ type: string }>;
      comparisons: Array<{ burstable: string; candidate: string; exact: boolean }>;
      regions: Array<{ id: string }>;
      families: Record<string, { unlimitedSurchargePerVcpuHour: number }>;
    };
    expect(body.sizes).toHaveLength(18);
    expect(body.comparisons).toHaveLength(18);
    expect(body.regions.length).toBeGreaterThanOrEqual(14);
    expect(Object.keys(body.families).sort()).toEqual(["t3a", "t4g", "t8i"]);
    expect(body.families["t8i"]?.unlimitedSurchargePerVcpuHour).toBe(0.06);
  });

  it("serves /api/aws/regions with the generated dataset", async () => {
    const res = await request("/api/aws/regions");
    expect(res.status).toBe(200);
    const body = res.json() as {
      probe: { template: string; note: string };
      groups: Array<{ id: string }>;
      regions: Array<{ code: string; name: string; group: string }>;
    };
    expect(body.regions).toHaveLength(33);
    expect(body.regions.find((r) => r.code === "us-east-1")?.name).toBe("US East (N. Virginia)");
    expect(body.probe.template).toContain("{region}");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("serves /api/data-transfer/pricing with the generated dataset", async () => {
    const res = await request("/api/data-transfer/pricing");
    expect(res.status).toBe(200);
    const body = res.json() as {
      internetOutFreeGb: number;
      regions: Array<{ code: string }>;
      prices: Record<string, { natGateway: { hourUsd: number } }>;
    };
    expect(body.internetOutFreeGb).toBe(100);
    expect(body.regions.length).toBeGreaterThanOrEqual(30);
    expect(body.prices["us-east-1"]?.natGateway.hourUsd).toBe(0.045);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("answers 405 for unsupported methods on known routes", async () => {
    const res = await request("/api/ebs/pricing", { method: "POST" });
    expect(res.status).toBe(405);
    const res2 = await request("/api/ec2/burst-spec", { method: "POST" });
    expect(res2.status).toBe(405);
    const res3 = await request("/api/aws/regions", { method: "POST" });
    expect(res3.status).toBe(405);
    const res4 = await request("/api/data-transfer/pricing", { method: "POST" });
    expect(res4.status).toBe(405);
  });

  it("serves /speedtest/ping", async () => {
    const res = await request("/speedtest/ping");
    expect(res.status).toBe(200);
    expect(res.text).toBe("pong");
  });

  it("streams the requested number of bytes from /speedtest/down", async () => {
    const res = await request("/speedtest/down?bytes=1024");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("1024");
    expect((await res.arrayBuffer()).byteLength).toBe(1024);
  });

  it("rejects invalid /speedtest/down sizes", async () => {
    for (const bad of ["abc", "100", "999999999"]) {
      const res = await request(`/speedtest/down?bytes=${bad}`);
      expect(res.status, `bytes=${bad}`).toBe(400);
    }
  });

  it("counts bytes on /speedtest/up", async () => {
    const body = new Uint8Array(4096).fill(7);
    const res = await request("/speedtest/up", { method: "POST", body });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ bytes_received: 4096 });
  });

  it("rejects oversized declared uploads with 413", async () => {
    const res = await request("/speedtest/up", {
      method: "POST",
      headers: { "content-length": String(20 * 1024 * 1024) },
      body: "x",
    });
    expect(res.status).toBe(413);
  });

  it("answers 405/404 under /speedtest/", async () => {
    const wrongMethod = await request("/speedtest/up");
    expect(wrongMethod.status).toBe(405);
    const missing = await request("/speedtest/nope");
    expect(missing.status).toBe(404);
  });

  it("answers JSON 404 for unknown API routes", async () => {
    const res = await request("/api/missing");
    expect(res.status).toBe(404);
    expect(res.json()).toMatchObject({ error: "not found", path: "/api/missing" });
  });

  it("answers the HTML 404 for unknown non-API paths", async () => {
    const res = await request("/nope");
    expect(res.status).toBe(404);
    expect(res.text).toContain("no such tool");
  });
});
