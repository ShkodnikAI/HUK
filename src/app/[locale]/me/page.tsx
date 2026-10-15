// /me (H-122 task 6): the Me tab resolves the session server-side
// (getServerSession with the very same makeAuthOptions the route handler
// uses) and passes plain props to the client view. The data-screen link
// is intentionally absent until H-214 delivers that page.

import { getServerSession } from "next-auth/next";
import { setRequestLocale } from "next-intl/server";
import { makeAuthOptions } from "@/server/auth/options";
import { loadEnv } from "@/server/env";
import { db } from "@/server/db";
import { MeView } from "@/components/auth/MeView";

export const dynamic = "force-dynamic";

export default async function MePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const env = loadEnv();
  const session = await getServerSession(makeAuthOptions(env));
  const email = session?.user?.email ?? null;

  let role: string | null = null;
  let inviteApplicable = false;
  if (email) {
    // The session user carries no id in the default type; the email is the
    // account email (database sessions re-read the user row per request).
    const user = await db.user.findUnique({ where: { email }, select: { role: true } });
    role = user?.role ?? null;
    // H-122: the invite screen is reachable from Me for a signed-in user
    // without the ARTIST role while the beta is invite-only (Owner
    // direction: codes are for artists only; listeners need no code).
    inviteApplicable = env.INVITE_ONLY && role !== null && role !== "ARTIST" && role !== "ADMIN";
  }

  return <MeView signedIn={Boolean(session)} email={email} role={role} inviteApplicable={inviteApplicable} />;
}
