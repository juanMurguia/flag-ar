import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Argentine Startups Flag",
  description: "A waving Argentine flag made of the logos of Argentine startups. Add yours.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://flag.ar"),
  openGraph: { title: "Argentine Startups Flag", url: "/", type: "website" },
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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
