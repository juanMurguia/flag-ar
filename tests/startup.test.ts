import { describe, expect, it } from "vitest";
import {
  accentColor, hexToRgb, hslToRgb, isLightLogo, nameFromDomain, pickBrandColor, removeSolidBackground, rgbToHsl,
  safeUrl, toStartup, visibleBounds,
} from "@/lib/flag/startup";

const base = { id: "a", domain: "pampalabs.com.ar", url: "https://pampalabs.com.ar/", image: "a.png" };

describe("toStartup", () => {
  it("falls back to the domain when the manifest has no profile", () => {
    const s = toStartup(base, "/files");
    expect(s.name).toBe("Pampalabs");
    expect(s.logo).toBe("/files/a.png");
    expect(s.website).toBe("https://pampalabs.com.ar/");
    expect(s.description).toBeUndefined();
    expect(s.socialLinks).toEqual([]);
  });
  it("drops unsafe links and caps long text", () => {
    const s = toStartup({
      ...base,
      url: "javascript:alert(1)",
      description: "x".repeat(500),
      socialLinks: [
        { label: "X", url: "javascript:alert(1)" },
        { label: "LinkedIn", url: "https://linkedin.com/company/pampa" },
      ],
    }, "/files");
    expect(s.website).toBe("https://pampalabs.com.ar/");
    expect(s.description).toHaveLength(220);
    expect(s.socialLinks).toEqual([{ label: "LinkedIn", url: "https://linkedin.com/company/pampa" }]);
  });
  it("accepts only http and https", () => {
    expect(safeUrl("https://a.com")).toBe("https://a.com/");
    expect(safeUrl("data:text/html,x")).toBeNull();
    expect(safeUrl(42)).toBeNull();
    expect(nameFromDomain("www.mate.com.ar")).toBe("Mate");
  });
});

function pixels(...colors: [number, number, number, number][]): number[] {
  return colors.flatMap((c) => Array.from({ length: 50 }, () => c).flat());
}

describe("brand colors", () => {
  it("picks the saturated color and ignores white, black, and transparent pixels", () => {
    const rgb = pickBrandColor(pixels([255, 255, 255, 255], [10, 10, 10, 255], [230, 57, 70, 255], [0, 200, 0, 0]));
    expect(rgb).toEqual([230, 57, 70]);
  });
  it("returns null for a monochrome logo, and no accent (plain white flag) for null", () => {
    expect(pickBrandColor(pixels([0, 0, 0, 255], [128, 128, 128, 255]))).toBeNull();
    expect(accentColor(null)).toBeNull();
  });
  it("keeps the accent in a mid lightness, so it reads on white", () => {
    for (const brand of [[200, 230, 255], [20, 10, 60]] as const) {
      const l = rgbToHsl(hexToRgb(accentColor([...brand])!))[2];
      expect(l).toBeGreaterThanOrEqual(0.31);
      expect(l).toBeLessThanOrEqual(0.56);
    }
  });
  it("round-trips HSL", () => {
    expect(hslToRgb(rgbToHsl([42, 157, 143]))).toEqual([42, 157, 143]);
  });
});

/** w × h image filled with bg, with a rectangle of fg from (x0, y0) to (x1, y1), inclusive. */
function image(w: number, h: number, bg: number[], fg: number[], x0: number, y0: number, x1: number, y1: number) {
  const px: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) px.push(...(x >= x0 && x <= x1 && y >= y0 && y <= y1 ? fg : bg));
  }
  return px;
}
const alphaAt = (px: number[], w: number, x: number, y: number) => px[(y * w + x) * 4 + 3];

describe("removeSolidBackground", () => {
  it("removes a white JPEG box and keeps the mark", () => {
    const px = image(10, 10, [252, 250, 255, 255], [230, 57, 70, 255], 3, 3, 6, 6);
    expect(removeSolidBackground(px, 10, 10)).toBe(true);
    expect(alphaAt(px, 10, 0, 0)).toBe(0);
    expect(alphaAt(px, 10, 4, 4)).toBe(255);
    expect(visibleBounds(px, 10, 10)).toEqual({ x: 3, y: 3, w: 4, h: 4 });
  });
  it("removes a dark box too, like a navy square behind a gold mark", () => {
    const px = image(10, 10, [17, 24, 39, 255], [230, 170, 70, 255], 3, 3, 6, 6);
    expect(removeSolidBackground(px, 10, 10)).toBe(true);
    expect(alphaAt(px, 10, 9, 9)).toBe(0);
    expect(pickBrandColor(px)).toEqual([230, 170, 70]);
  });
  it("keeps background-colored pixels enclosed by the mark (a ring's hole)", () => {
    const px = image(12, 12, [255, 255, 255, 255], [0, 0, 0, 255], 2, 2, 9, 9);
    for (let y = 5; y <= 6; y++) for (let x = 5; x <= 6; x++) px.splice((y * 12 + x) * 4, 4, 255, 255, 255, 255);
    removeSolidBackground(px, 12, 12);
    expect(alphaAt(px, 12, 5, 5)).toBe(255);
  });
  it("leaves a PNG with transparency alone", () => {
    const px = image(10, 10, [0, 0, 0, 0], [230, 57, 70, 255], 3, 3, 6, 6);
    expect(removeSolidBackground(px, 10, 10)).toBe(false);
  });
  it("leaves a logo that is one flat color, and a mark that runs off the edge", () => {
    expect(removeSolidBackground(image(8, 8, [10, 90, 200, 255], [10, 90, 200, 255], 0, 0, 0, 0), 8, 8)).toBe(false);
    expect(removeSolidBackground(image(8, 8, [255, 255, 255, 255], [0, 0, 0, 255], 0, 0, 7, 3), 8, 8)).toBe(false);
  });
  it("returns null bounds for an empty image", () => {
    expect(visibleBounds(image(4, 4, [0, 0, 0, 0], [0, 0, 0, 0], 0, 0, 0, 0), 4, 4)).toBeNull();
  });
});

describe("isLightLogo", () => {
  // n pixels of one RGBA color.
  const px = (n: number, rgba: [number, number, number, number]) => Array.from({ length: n }, () => rgba).flat();

  it("flags a white mark on transparency", () => {
    expect(isLightLogo([...px(30, [255, 255, 255, 255]), ...px(70, [0, 0, 0, 0])])).toBe(true);
  });
  it("keeps a dark mark on cream", () => {
    expect(isLightLogo([...px(30, [20, 20, 30, 255]), ...px(70, [0, 0, 0, 0])])).toBe(false);
  });
  it("keeps an opaque image with a white box on cream", () => {
    expect(isLightLogo([...px(90, [255, 255, 255, 255]), ...px(10, [200, 0, 0, 255])])).toBe(false);
  });
  it("keeps a mixed logo (white letter on a colored circle) on cream", () => {
    expect(isLightLogo([...px(10, [255, 255, 255, 255]), ...px(30, [108, 43, 217, 255]), ...px(60, [0, 0, 0, 0])])).toBe(false);
  });
  it("returns false for a fully transparent image", () => {
    expect(isLightLogo(px(10, [0, 0, 0, 0]))).toBe(false);
  });
});
