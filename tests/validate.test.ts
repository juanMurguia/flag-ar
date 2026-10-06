import { describe, expect, it } from "vitest";
import { networkKey, normalizeLink, sniffImage } from "@/lib/server/validate";

describe("normalizeLink", () => {
  it("adds https and lowercases the host", () => {
    expect(normalizeLink("Acme.COM/about")).toEqual({ ok: true, url: "https://acme.com/about", domain: "acme.com" });
  });
  it("strips www from the domain but keeps the URL", () => {
    const r = normalizeLink("http://www.acme.com.ar");
    expect(r).toMatchObject({ ok: true, domain: "acme.com.ar", url: "http://www.acme.com.ar/" });
  });
  it.each([
    "javascript:alert(1)", "ftp://acme.com", "data:text/html,hi", "http://localhost:3000",
    "http://127.0.0.1", "http://[::1]/", "http://2130706433", "http://0x7f000001", "http://user:pw@acme.com",
    "https://bit.ly/abc", "https://www.tinyurl.com/x", "http://printer.local", "acme", "https://acme.com:8443",
    "https://-bad-.com", "", "a b.com",
  ])("rejects %s", (input) => {
    expect(normalizeLink(input).ok).toBe(false);
  });
  it("accepts punycode TLDs", () => {
    expect(normalizeLink("https://ejemplo.xn--p1ai").ok).toBe(true);
  });
});

describe("sniffImage", () => {
  it("detects PNG, JPEG, WebP", () => {
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.ext).toBe("png");
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))?.ext).toBe("jpg");
    expect(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))?.ext).toBe("webp");
  });
  it("rejects SVG, GIF, and HTML", () => {
    expect(sniffImage(new TextEncoder().encode("<svg xmlns="))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("GIF89a"))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("<html>"))).toBeNull();
  });
});

describe("networkKey", () => {
  it("groups IPv4 by /24", () => {
    expect(networkKey("200.45.12.99")).toBe("200.45.12.0/24");
    expect(networkKey("::ffff:200.45.12.99")).toBe("200.45.12.0/24");
  });
  it("groups IPv6 by /64", () => {
    expect(networkKey("2800:810:4a1:1::5")).toBe("2800:0810:04a1:0001::/64");
    expect(networkKey("2800:810:4a1:1:aaaa:bbbb:cccc:dddd")).toBe("2800:0810:04a1:0001::/64");
  });
});
