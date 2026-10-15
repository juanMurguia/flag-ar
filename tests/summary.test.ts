import { describe, expect, it } from "vitest";
import { SUMMARY_MAX, parseSummary } from "@/lib/server/summary";

describe("parseSummary", () => {
  it("prefers og:description over the plain description", () => {
    const html = `<head><meta name="description" content="Plain one"><meta property="og:description" content="Open Graph one"></head>`;
    expect(parseSummary(html)).toBe("Open Graph one");
  });

  it("falls back to the meta description and decodes entities", () => {
    const html = `<head><meta content='Pagos &amp; cobros en &#x41;rgentina' name='description'></head>`;
    expect(parseSummary(html)).toBe("Pagos & cobros en Argentina");
  });

  it("ignores tags after the head", () => {
    expect(parseSummary(`<head><title>x</title></head><meta name="description" content="Body meta here">`)).toBeNull();
  });

  it("returns null without a description", () => {
    expect(parseSummary("<html><head><title>Only a title</title></head></html>")).toBeNull();
  });

  it("cuts long text at a word", () => {
    const long = "palabra ".repeat(60);
    const out = parseSummary(`<head><meta name="description" content="${long}"></head>`)!;
    expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(out.endsWith("palabra…")).toBe(true);
  });
});
