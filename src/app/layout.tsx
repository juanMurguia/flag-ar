import type { Metadata, Viewport } from "next";
import { Schibsted_Grotesk } from "next/font/google";
import { ViewTransition } from "react";
import { Toaster } from "@/components/Toast";
import "./globals.css";

// Variable font: one self-hosted file covers every weight globals.css uses (400-700).
const sans = Schibsted_Grotesk({ subsets: ["latin"], variable: "--font-sans", display: "swap" });

export const metadata: Metadata = {
  title: "flag.ar · Izá la bandera de tu startup",
  description: "La bandera argentina flameando al atardecer. Izá la de tu startup al lado y entrá al Salón de la Fama.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://flag.ar"),
  openGraph: { title: "flag.ar · Izá la bandera de tu startup", url: "/", type: "website", locale: "es_AR" },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light",
  themeColor: "#6f62a3",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-AR" className={sans.variable}>
      <body>
        {/* Page changes cross-fade through the dusk backdrop (see globals.css, "Page changes"). */}
        <ViewTransition default="page">{children}</ViewTransition>
        <Toaster />
      </body>
    </html>
  );
}
