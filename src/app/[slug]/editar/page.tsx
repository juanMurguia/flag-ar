import type { Metadata } from "next";
import EditForm from "./EditForm";

export const metadata: Metadata = { title: "Editar bandera · flag.ar", robots: { index: false, follow: false } };

// The token lives in the URL fragment (#t=...): it never reaches server logs or a Referer header.
export default async function EditPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <EditForm slug={slug} />;
}
