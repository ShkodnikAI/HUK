import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Cormorant_Garamond, Inter } from "next/font/google";
import { routing } from "@/i18n/routing";
import { LanguageSwitcher } from "@/components/player/language-switcher";
import { RadioPlayer } from "@/components/player/radio-player";
import { BottomNav, TopNav } from "@/components/shell/Nav";
import { OfflineBanner } from "@/components/shell/OfflineBanner";
import { Wordmark } from "@/components/shell/Wordmark";

import "../globals.css";

// H-120 task 2: self-hosted fonts via next/font — no request to a
// third-party font host from the browser at runtime (next/font inlines the
// files at build time). Cormorant Garamond is for the wordmark and large
// titles only; Inter carries the interface.
const inter = Inter({
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-inter",
});
const cormorant = Cormorant_Garamond({
  subsets: ["latin", "cyrillic"],
  weight: ["500", "600"],
  display: "swap",
  variable: "--font-cormorant",
});

export function generateStaticParams(): Array<{ locale: string }> {
  return routing.locales.map((locale) => ({ locale }));
}

export const metadata: Metadata = {
  title: "HUK",
  description:
    "Free, non-commercial, international 24/7 radio for music authors publish themselves.",
};

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations("shell");

  return (
    <html lang={locale} className={`${inter.variable} ${cormorant.variable}`}>
      <body className="min-h-screen antialiased font-ui">
        <NextIntlClientProvider>
          <a href="#main" className="skip-link">
            {t("skipToContent")}
          </a>
          <OfflineBanner />
          <header className="flex items-center justify-between gap-4 px-5 py-3 lg:px-8">
            <div className="flex items-center gap-6">
              <Wordmark />
              <TopNav />
            </div>
            <LanguageSwitcher />
          </header>
          <main
            id="main"
            className="mx-auto w-full max-w-[1100px] px-5 pb-28 lg:px-8 lg:pb-8"
          >
            {children}
          </main>
          {/*
            The persistent player owns the single <audio> element and must
            stay mounted across navigation (ARCHITECTURE §5): it lives in
            the LAYOUT, outside <main> — navigation swaps the children only.
          */}
          <footer className="fixed inset-x-0 bottom-[56px] z-30 px-5 pb-2 lg:static lg:px-8 lg:pb-6">
            <RadioPlayer />
          </footer>
          <BottomNav />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
