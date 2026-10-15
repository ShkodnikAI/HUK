// /cabinet (H-123 task 5): the artist's own tracks per Cabinet.dc.html.
// The same gate order as /submit: the role check runs first on the real
// request headers — anonymous goes to sign-in, everyone else gets the
// artists-only screen. The list itself is client-side over
// GET /api/tracks/mine (status badge in words, the statement of reasons,
// the inline lyrics editor over PATCH /api/tracks/[id]/lyrics and the
// server-reported quota line). Statistics, the public-profile link and
// any external links are intentionally absent — they belong to H-401.

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { requireRole } from "@/server/guard";
import { HttpError } from "@/server/http/errors";
import { CabinetView } from "./CabinetView";

export const dynamic = "force-dynamic";

/** Rebuilds the request for the guard from the real server headers. */
async function gateRequest(): Promise<Request> {
  const h = await headers();
  return new Request("http://localhost/cabinet", { headers: h });
}

export default async function CabinetPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("cabinet");

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

  return <CabinetView />;
}
