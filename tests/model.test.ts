import { describe, expect, it } from "vitest";
import {
  bySeat, cleanCategory, cleanName, contrast, defaultBackground, dominantColor, isValidSlug,
  normalizeStartupLink, slugify,
} from "@/lib/startups/model";
import { hallSlots, phaseOf, rowSlots } from "@/lib/flag/salon";

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

describe("default flag color", () => {
  const px = (rgb: number[], n = 100) => Array.from({ length: n }, () => [...rgb, 255]).flat();
  it("puts dark logos on white", () => {
    expect(defaultBackground(dominantColor(px([0, 0, 0])))).toBe("#ffffff");
    expect(defaultBackground([26, 31, 58])).toBe("#ffffff"); // navy wordmark
  });
  it("puts light logos on black", () => {
    expect(defaultBackground(dominantColor(px([255, 255, 0])))).toBe("#000000");
    expect(defaultBackground([255, 255, 255])).toBe("#000000");
  });
  it("picks the neutral with more contrast for mid tones, white when there is no logo", () => {
    expect(defaultBackground([128, 128, 128])).toBe("#000000");
    expect(defaultBackground(null)).toBe("#ffffff");
  });
  it("measures WCAG contrast", () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 0);
  });
});

describe("salon layout", () => {
  it("alternates sides and never puts two flags on one spot", () => {
    const slots = hallSlots(12, 3);
    expect(slots).toHaveLength(12);
    expect(new Set(slots.map((p) => `${p.x},${p.z}`)).size).toBe(12);
    expect(slots[0].side).toBe(-1);
    expect(slots[1].side).toBe(1);
  });
  it("puts the first six in one front row, even around the axis", () => {
    const row = hallSlots(6, 3);
    expect(new Set(row.map((p) => p.z)).size).toBe(1);
    const centers = row.map((p) => p.x + 3.1 / 2); // cloths fly to the right of the pole
    expect(centers[0]).toBeCloseTo(-centers[1]);
    expect(centers[4]).toBeCloseTo(-centers[5]);
    expect(Math.abs(centers[0])).toBeLessThan(Math.abs(centers[2]));
    expect(Math.abs(centers[2])).toBeLessThan(Math.abs(centers[4]));
    expect(hallSlots(7, 3)[6].z).toBeLessThan(row[0].z);
  });
  it("staggers the second row half a step outward", () => {
    const [a, , , , , , b] = hallSlots(7, 3);
    expect(Math.abs(b.x - a.x)).toBeCloseTo(4.5 / 2);
  });
  it("lines the row up from most likes (left) to fewest (right), shrinking", () => {
    const row = rowSlots([90, 40, 40, 3, 0]); // seat order: most likes first
    const xs = row.map((p) => p.x), ss = row.map((p) => p.s!);
    for (let i = 1; i < row.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
    for (let i = 1; i < row.length; i++) expect(ss[i]).toBeLessThanOrEqual(ss[i - 1]);
    expect(ss[1]).toBe(ss[2]); // a tie is the same size
    expect(xs[0] + (xs[4] + ss[4] * 3.1)).toBeCloseTo(0); // centered on the axis
    // Cloths never overlap: each starts after the one to its left ends.
    for (let i = 1; i < row.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1] + ss[i - 1] * 3.1);
  });
  it("sizes every flag the same when nobody has likes, and never grows to the right", () => {
    expect(new Set(rowSlots([0, 0, 0]).map((p) => p.s)).size).toBe(1);
    const odd = rowSlots([5, 6, 1]); // a visitor's like reordered seats before the counts caught up
    expect(odd[0].s!).toBeGreaterThanOrEqual(odd[1].s!);
  });
  it("gives neighbors different wave phases", () => {
    expect(Math.abs(phaseOf(1) - phaseOf(0))).toBeGreaterThan(0.5);
  });
});

describe("bySeat", () => {
  it("puts the most liked flag first, the older one first on a tie", () => {
    const list = [
      { id: "a", likes: 2, order: 1 },
      { id: "b", likes: 9, order: 3 },
      { id: "c", likes: 2, order: 0 },
      { id: "d", likes: 0, order: 2 },
    ];
    expect(list.sort(bySeat).map((s) => s.id)).toEqual(["b", "c", "a", "d"]);
  });
});
