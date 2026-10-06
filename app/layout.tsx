import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "QuotaOps",
  description: "Local-first quota and capacity management for AI agents.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
