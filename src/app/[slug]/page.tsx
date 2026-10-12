import type { Metadata } from "next";
import { notFound } from "next/navigation";
import StartupView from "@/components/StartupView";
import { getStartup } from "@/lib/server/startups";
import { categoryLabel, isValidSlug, type PublicStartup } from "@/lib/startups/model";

const DEMO: PublicStartup = {
  id: "00000000-0000-4000-8000-000000000000", slug: "demo", name: "Pampa Labs", city: null, category: "agtech",
  link: "https://pampalabs.com.ar/", domain: "pampalabs.com.ar",
  logoUrl: "/sample/e96f60e2-4e09-4b54-ab98-0d9fe05c87c0.png", bgColor: "#f3e6d4", order: 42,
  status: "approved", featured: false, createdAt: "2026-10-01T15:00:00Z", approvedAt: "2026-10-01T16:00:00Z",
};

// Rendered on first visit, then cached. Edits and reviews invalidate the startup's tag.
export const revalidate = 3600;

// No pages at build time; each one renders on its first visit, then stays cached (ISR).
export async function generateStaticParams() {
  return [];
}

async function load(params: Promise<{ slug: string }>) {
  const { slug } = await params;
  if (!isValidSlug(slug)) return null;
  // Dev only: /demo shows a sample startup without a database.
  if (process.env.NODE_ENV !== "production" && slug === "demo") return DEMO;
  return getStartup(slug);
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const s = await load(params);
  if (!s) return { title: "No encontrada · flag.ar" };
  const title = `${s.name} flamea en flag.ar 🇦🇷`;
  const description = `Bandera #${s.order}${categoryLabel(s.category) ? ` · ${categoryLabel(s.category)}` : ""}. La bandera de ${s.name} al lado de la argentina.`;
  return {
    title,
    description,
    alternates: { canonical: `/${s.slug}` },
    openGraph: { title, description, url: `/${s.slug}`, type: "website" },
    twitter: { card: "summary_large_image", title, description },
    // A flag in review is public on its URL, but search engines wait for approval.
    robots: s.status === "approved" ? undefined : { index: false, follow: false },
  };
}

export default async function StartupPage({ params }: { params: Promise<{ slug: string }> }) {
  const s = await load(params);
  if (!s) notFound();
  return <StartupView startup={s} />;
}
