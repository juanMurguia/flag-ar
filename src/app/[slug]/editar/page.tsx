import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getStartup } from "@/lib/server/startups";
import EditForm from "./EditForm";

export const metadata: Metadata = { title: "Pedir un cambio · flag.ar", robots: { index: false, follow: false } };

/** "Pedir un cambio": the form starts from the flag as it is now. The change waits for an admin. */
export default async function EditPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const s = await getStartup(slug);
  if (!s) notFound();
  return <EditForm current={{ slug: s.slug, name: s.name, category: s.category, bgColor: s.bgColor, logoUrl: s.logoUrl }} />;
}
