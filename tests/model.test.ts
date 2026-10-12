import { describe, expect, it } from "vitest";
import { signEditToken, verifyEditToken } from "@/lib/server/editToken";
import {
  cleanCategory, cleanName, contrast, defaultBackground, dominantColor, emailMatchesDomain, isValidSlug,
  normalizeStartupLink, slugify,
} from "@/lib/startups/model";
import { gridSize, gridSlots, phaseOf } from "@/lib/flag/salon";

describe("slugify", () => {
  it("drops accents and symbols", () => {
    expect(slugify("Pampa Labs S.A.")).toBe("pampa-labs-s-a");
    expect(slugify("Ñandú Tech")).toBe("nandu-tech");
    expect(slugify("!!!")).toBe("");
  });
  it("rejects reserved paths", () => {
    expect(isValidSlug("salon")).toBe(false);
    expect(isValidSlug("admin")).toBe(false);
    expect(isValidSlug("pampa-labs")).toBe(true);
    expect(isValidSlug("-x")).toBe(false);
  });
});

describe("form fields", () => {
  it("cleans the name and caps it at 60", () => {
    expect(cleanName("  Pampa \n Labs ")).toBe("Pampa Labs");
    expect(cleanName("x".repeat(61))).toBeNull();
    expect(cleanName("")).toBeNull();
  });
  it("accepts only listed category keys", () => {
    expect(cleanCategory("fintech")).toBe("fintech");
    expect(cleanCategory("Fintech")).toBeNull(); // labels are not keys
    expect(cleanCategory("springfield")).toBeNull();
    expect(cleanCategory(undefined)).toBeNull();
  });
});

describe("normalizeStartupLink", () => {
  it("keys a website by its bare domain", () => {
    const r = normalizeStartupLink("www.pampa.com.ar/about");
    expect(r).toMatchObject({ ok: true, domain: "pampa.com.ar", kind: "web" });
  });
  it("keys an X profile by handle, in lower case", () => {
    expect(normalizeStartupLink("https://twitter.com/PampaLabs")).toMatchObject({ ok: true, domain: "x.com/pampalabs", url: "https://x.com/PampaLabs" });
    expect(normalizeStartupLink("@PampaLabs")).toMatchObject({ ok: true, domain: "x.com/pampalabs" });
  });
  it("rejects X pages that are not profiles", () => {
    expect(normalizeStartupLink("x.com/home").ok).toBe(false);
    expect(normalizeStartupLink("x.com").ok).toBe(false);
  });
});

describe("emailMatchesDomain", () => {
  it("accepts the domain and its subdomains only", () => {
    expect(emailMatchesDomain("ana@pampa.com.ar", "pampa.com.ar")).toBe(true);
    expect(emailMatchesDomain("ana@mail.pampa.com.ar", "pampa.com.ar")).toBe(true);
    expect(emailMatchesDomain("ana@evilpampa.com.ar", "pampa.com.ar")).toBe(false);
    expect(emailMatchesDomain("ana@pampa.com.ar.evil.io", "pampa.com.ar")).toBe(false);
    expect(emailMatchesDomain("ana@x.com", "x.com/pampa")).toBe(false);
  });
});

describe("default flag color", () => {
  const px = (rgb: number[], n = 100) => Array.from({ length: n }, () => [...rgb, 255]).flat();
  it("inverts the dominant color", () => {
    expect(defaultBackground(dominantColor(px([0, 0, 0])))).toBe("#ffffff");
    expect(defaultBackground(dominantColor(px([255, 255, 0])))).toBe("#0000ff");
  });
  it("falls back to white when the inverse has no contrast", () => {
    expect(defaultBackground([128, 128, 128])).toBe("#ffffff");
    expect(defaultBackground(null)).toBe("#ffffff");
  });
  it("measures WCAG contrast", () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 0);
  });
});

describe("edit tokens", () => {
  const secret = "s".repeat(32);
  const claims = { sid: "abc", v: 2, em: "a@b.c", exp: Math.floor(Date.now() / 1000) + 60 };
  it("round-trips", () => {
    expect(verifyEditToken(signEditToken(claims, secret), secret)).toEqual(claims);
  });
  it("rejects a changed payload, a wrong secret, and an expired token", () => {
    const t = signEditToken(claims, secret);
    const forged = Buffer.from(JSON.stringify({ ...claims, sid: "other" })).toString("base64url") + "." + t.split(".")[1];
    expect(verifyEditToken(forged, secret)).toBeNull();
    expect(verifyEditToken(t, "x".repeat(32))).toBeNull();
    expect(verifyEditToken(signEditToken({ ...claims, exp: 1 }, secret), secret)).toBeNull();
  });
});

describe("salon layout", () => {
  it("alternates sides and never puts two flags on one spot", () => {
    const slots = gridSlots(10, 40);
    expect(slots).toHaveLength(800);
    const seen = new Set<string>();
    for (const p of slots) {
      const key = `${p.x},${p.z}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(slots[0].side).toBe(-1);
    expect(slots[1].side).toBe(1);
  });
  it("seats the first startups near the corridor and the front", () => {
    const slots = gridSlots(10, 40);
    const inner = Math.min(...slots.map((p) => Math.abs(p.x)));
    expect(Math.abs(slots[0].x)).toBe(inner);
    expect(Math.abs(slots[0].z)).toBeLessThanOrEqual(Math.abs(slots[799].z));
  });
  it("grows the grid so every startup has a slot", () => {
    for (const n of [0, 10, 900, 5000]) {
      const { cols, rows } = gridSize(n);
      expect(cols * 2 * rows).toBeGreaterThanOrEqual(n);
      expect(cols).toBeGreaterThanOrEqual(10);
    }
  });
  it("gives neighbors different wave phases", () => {
    expect(Math.abs(phaseOf(1) - phaseOf(0))).toBeGreaterThan(0.5);
  });
});
