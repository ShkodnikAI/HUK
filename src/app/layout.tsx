import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HUK",
  description:
    "Free, non-commercial, international 24/7 radio for music authors publish themselves.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
