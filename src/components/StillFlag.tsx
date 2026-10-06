"use client";

import { useEffect, useRef } from "react";
import { LAYOUT_H, LAYOUT_W, MAX_LOGOS, type ManifestLogo } from "@/lib/flag/layout";
import { drawFlag, type LogoImage } from "@/lib/flag/texture";

/** No-WebGL fallback: a still image of the flag and a visible brand list. */
export default function StillFlag({ logos, filesBase }: { logos: ManifestLogo[]; filesBase: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const shown = logos.slice(0, MAX_LOGOS);
    const images: (LogoImage | null)[] = shown.map(() => null);
    const draw = () => drawFlag(canvas, { logos: images, soloIndex: null });
    draw();
    shown.forEach((l, i) => {
      const img = new Image();
      img.onload = () => {
        images[i] = img;
        draw();
      };
      img.src = `${filesBase}/${encodeURIComponent(l.image)}`;
    });
  }, [logos, filesBase]);

  return (
    <div className="still">
      <canvas ref={ref} width={LAYOUT_W} height={LAYOUT_H} role="img" aria-label="Argentine flag with startup logos" />
      <p className="still-note">Your browser cannot show the 3D flag. Here is a still image.</p>
      {logos.length > 0 && (
        <ul className="still-list">
          {logos.map((l) => (
            <li key={l.id}>
              <a href={l.url} target="_blank" rel="noopener noreferrer nofollow">{l.domain}</a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
