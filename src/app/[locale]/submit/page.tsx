// /submit (H-123 task 4): the artist submission form per Submit.dc.html.
// Order is the contract (mirrors the mod console): the role gate runs
// FIRST on the real request headers — anonymous goes to sign-in, everyone
// without the ARTIST role gets the artists-only screen, and no data has
// loaded at that point. The server page resolves the two values the client
// must never invent: the curated language set (the binding H-402
// vocabulary — the same list the LANGUAGE term derives from) and the
// current tosVersion (read from the server constant, never typed by the
// user or duplicated in client code).

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { requireRole } from "@/server/guard";
import { HttpError } from "@/server/http/errors";
import { LANGUAGES } from "@/server/taxonomy/vocabulary";
import { CURRENT_TOS_VERSION } from "@/server/legal/versions";
import { SubmitView } from "./SubmitView";

export const dynamic = "force-dynamic";

/** Rebuilds the request for the guard from the real server headers. */
async function gateRequest(): Promise<Request> {
  const h = await headers();
  return new Request("http://localhost/submit", { headers: h });
}

export default async function SubmitPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("submit");

  try {
    await requireRole(await gateRequest(), "ARTIST");
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      redirect(`/${locale}/signin`);
    }
    return (
      <main className="mx-auto flex min-h-[60vh] max-w-2xl flex-col gap-4 px-6 py-10">
        <h1 className="font-display text-3xl font-semibold">{t("title")}</h1>
        <p className="text-muted">{t("artistsOnly")}</p>
      </main>
    );
  }

  // The curated BCP-47 set: the binding OWNER-approved LANGUAGE vocabulary
  // (H-402 decision, prisma/taxonomy/languages.json) including "other".
  // Labels are localized through the catalogs (taxonomy.language.<slug>);
  // the English label rides along as the fallback the vocabulary defines.
  const languages = Object.entries(LANGUAGES).map(([slug, label]) => ({ slug, label }));

  return <SubmitView languages={languages} tosVersion={CURRENT_TOS_VERSION} />;
}
