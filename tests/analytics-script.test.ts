/**
 * Tests for the PostHog bootstrap generator
 * (scripts/generate-analytics.mjs): the snippet must boot PostHog with the
 * same options the blog uses, and the token/host must be injection-safe.
 */

import { describe, expect, it } from "vitest";

import { buildAnalyticsScript } from "../scripts/generate-analytics.mjs";

const TOKEN = "phc_test_token";
const HOST = "https://us.i.posthog.com";

describe("buildAnalyticsScript", () => {
  it("boots PostHog with the blog's init options", () => {
    const script = buildAnalyticsScript({ token: TOKEN, host: HOST });
    expect(script).toContain(`posthog.init("${TOKEN}", {`);
    expect(script).toContain(`api_host: "${HOST}",`);
    expect(script).toContain("capture_pageview: 'history_change',");
    expect(script).toContain("capture_unhandled_errors: true");
    expect(script).toContain("capture_unhandled_rejections: true");
    expect(script).toContain("capture_console_errors: false");
    expect(script).toContain("tracing_headers: [window.location.hostname]");
  });

  it("guards against a double init and uses the official snippet", () => {
    const script = buildAnalyticsScript({ token: TOKEN, host: HOST });
    expect(script).toContain("if (!window.__posthog_initialized) {");
    expect(script).toContain("window.posthog||[]");
    expect(script).toContain("-assets.i.posthog.com");
  });

  it("escapes `<` so a value cannot close the script tag", () => {
    const script = buildAnalyticsScript({ token: "phc_<script>", host: "https://x/" });
    expect(script).toContain("phc_\\u003cscript>");
    expect(script).not.toContain("<script>");
  });

  it("requires both variables", () => {
    expect(() => buildAnalyticsScript({ token: "", host: HOST })).toThrow(/TOKEN/);
    expect(() => buildAnalyticsScript({ token: TOKEN, host: "" })).toThrow(/HOST/);
  });
});
