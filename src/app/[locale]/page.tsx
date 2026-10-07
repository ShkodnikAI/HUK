import { getTranslations } from "next-intl/server";
import { setRequestLocale } from "next-intl/server";

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("home");

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-2xl flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-4xl font-bold tracking-tight">{t("brand")}</h1>
      <p className="text-lg text-neutral-400">{t("tagline")}</p>
      <p className="text-sm text-neutral-500">{t("status")}</p>
    </main>
  );
}
