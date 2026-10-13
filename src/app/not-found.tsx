import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "No encontrada · flag.ar", robots: { index: false, follow: false } };

/** Any unknown URL or missing flag: same sky, and a way back instead of a dead end. */
export default function NotFound() {
  return (
    <main className="lost">
      <h1>Esta bandera no flamea acá</h1>
      <p>Puede que el link tenga un error, o que la bandera ya no esté.</p>
      <div className="lost-actions">
        <Link className="btn primary" href="/">Ir al Salón de la Fama</Link>
        <Link className="btn" href="/izar">Izá la tuya</Link>
      </div>
    </main>
  );
}
