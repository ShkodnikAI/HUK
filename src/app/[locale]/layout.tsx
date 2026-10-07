import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { LanguageSwitcher } from "@/components/player/language-switcher";
import { RadioPlayer } from "@/components/player/radio-player";
import { useTranslations } from "next-intl";

import "../globals.css";

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
  const t = await getTranslations("home");

  return (
    <html lang={locale}>
      <body className="min-h-screen antialiased">
        <NextIntlClientProvider>
          <header className="flex items-center justify-between px-6 py-4">
            <span className="font-semibold text-[#D4AF37]">{t("brand")}</span>
            <LanguageSwitcher />
          </header>
          {children}
          <footer className="px-6 pb-8">
            <RadioPlayer />
          </footer>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
