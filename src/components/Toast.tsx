"use client";

import { useEffect, useState } from "react";

const EVENT = "flag:toast";
const DURATION = 6000;

/** Shows a short message at the bottom of the screen. The Toaster lives in the root layout, so it survives navigation. */
export function toast(message: string) {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: message }));
}

export function Toaster() {
  const [item, setItem] = useState<{ id: number; message: string } | null>(null);

  useEffect(() => {
    const onToast = (e: Event) => setItem({ id: Date.now(), message: (e as CustomEvent<string>).detail });
    window.addEventListener(EVENT, onToast);
    return () => window.removeEventListener(EVENT, onToast);
  }, []);

  useEffect(() => {
    if (!item) return;
    const t = setTimeout(() => setItem(null), DURATION);
    return () => clearTimeout(t);
  }, [item]);

  // The live region stays mounted so screen readers announce each new message.
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {item && (
        <div className="toast" key={item.id}>
          <span aria-hidden="true">✓</span>
          <p>{item.message}</p>
        </div>
      )}
    </div>
  );
}
