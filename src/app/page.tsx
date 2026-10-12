import type { Metadata } from "next";
import SalonApp from "@/components/SalonApp";
import { listApproved } from "@/lib/server/startups";

export const metadata: Metadata = {
  title: "Salón de la Fama · flag.ar",
  description: "Un paseo de mástiles con las banderas de las startups argentinas, al lado de la bandera argentina.",
  alternates: { canonical: "/" },
};

// Home is the Hall of Fame. Static with a 5-minute refresh; approvals invalidate the "salon" tag sooner.
export const revalidate = 300;

export default async function Home() {
  const startups = await listApproved().catch(() => []);
  return <SalonApp initial={startups} />;
}
