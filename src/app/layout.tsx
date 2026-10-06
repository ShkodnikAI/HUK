import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "HUK — круглосуточное радио с ИИ-модерацией",
  description:
    "Интернет-радиостанция 24/7: тематические плейлисты, загрузка своих композиций, ИИ-модерация треков (транскрипция речи + политика станции) и ИИ-диджей ВЕКТОР.",
  keywords: ["радио", "интернет-радио", "ИИ-модерация", "плейлисты", "стрим", "HUK"],
  openGraph: {
    title: "HUK",
    description: "Круглоосуточное радио с ИИ-модерацией: ваши треки — наша волна",
    siteName: "HUK",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
