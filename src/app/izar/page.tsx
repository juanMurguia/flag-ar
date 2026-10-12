import type { Metadata } from "next";
import FlagApp from "@/components/FlagApp";

export const metadata: Metadata = {
  title: "Izá tu bandera · flag.ar",
  description: "Izá la bandera de tu startup al lado de la bandera argentina.",
  alternates: { canonical: "/izar" },
};

// Static page. Vercel's CDN serves it.
export default function IzarPage() {
  return <FlagApp />;
}
