// /invite (H-122 task 5): the artist invite screen (reachable from Me for
// a signed-in listener while the beta is invite-only).

import { setRequestLocale } from "next-intl/server";
import { InviteScreen } from "@/components/auth/InviteScreen";

export default async function InvitePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <InviteScreen />;
}
