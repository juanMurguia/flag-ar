"use client";

import { useEffect, useRef } from "react";

declare global {
  interface Window {
    hcaptcha?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id?: string) => void;
    };
    __hcaptchaLoad?: Promise<void>;
  }
}

const SITE_KEY = process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY || "10000000-ffff-ffff-ffff-000000000001";

function loadScript(): Promise<void> {
  if (window.hcaptcha) return Promise.resolve();
  if (!window.__hcaptchaLoad) {
    window.__hcaptchaLoad = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://js.hcaptcha.com/1/api.js?render=explicit&recaptchacompat=off";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("hCaptcha failed to load"));
      document.head.appendChild(s);
    });
  }
  return window.__hcaptchaLoad;
}

/** hCaptcha widget. Calls onToken with a fresh token, or null when it expires. */
export default function HCaptcha({ onToken, resetKey }: { onToken: (t: string | null) => void; resetKey?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const cb = useRef(onToken);
  cb.current = onToken;

  useEffect(() => {
    let alive = true;
    loadScript()
      .then(() => {
        if (!alive || !el.current || !window.hcaptcha) return;
        widget.current = window.hcaptcha.render(el.current, {
          sitekey: SITE_KEY,
          callback: (t: string) => cb.current(t),
          "expired-callback": () => cb.current(null),
          "error-callback": () => cb.current(null),
        });
      })
      .catch(() => cb.current(null));
    return () => {
      alive = false;
      if (widget.current && window.hcaptcha) window.hcaptcha.remove(widget.current);
    };
  }, []);

  useEffect(() => {
    if (resetKey && widget.current && window.hcaptcha) {
      window.hcaptcha.reset(widget.current);
      cb.current(null);
    }
  }, [resetKey]);

  return <div ref={el} className="captcha" />;
}
