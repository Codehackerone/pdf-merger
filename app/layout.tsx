import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PDF Merger",
  description: "Merge PDFs right in your browser. Files never leave your device.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
