import type { Metadata } from "next";
import AdminPanel from "./AdminPanel";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

// The proxy already returned 404 to anyone who is not the signed-in owner with aal2.
export const dynamic = "force-dynamic";

export default function AdminPage() {
  return <AdminPanel />;
}
