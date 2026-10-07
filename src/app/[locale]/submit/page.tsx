import { getTranslations } from "next-intl/server";
import { setRequestLocale } from "next-intl/server";

export default async function SubmitPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("submit");

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-2xl flex-col gap-4 px-6 py-10">
      <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
      <p className="text-neutral-400">{t("description")}</p>
      <p className="text-sm text-neutral-500">{t("betaNote")}</p>
      <p className="text-sm text-neutral-500">{t("apiNote")}</p>
    </main>
  );
}
