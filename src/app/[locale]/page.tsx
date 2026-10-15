// The radio screen (H-121): the home page renders the radio view over the
// persistent engine — LIVE badge, the now-playing card, the shared-timeline
// progress, reactions, and the QuietState when nothing is on air.

import { setRequestLocale } from "next-intl/server";
import { RadioScreen } from "@/components/player/RadioScreen";

export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <RadioScreen />;
}
