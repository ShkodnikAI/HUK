// /playlists (H-121 task 5): the listener's playlists per
// Playlists.dc.html — list, create, rename, delete, open with items,
// reorder (the PATCH route), remove an item, unavailable items marked in
// words, and "Play" handing the queue to the persistent engine. Limits
// (50 playlists x 500 tracks) surface in the user's language when the
// API answers 409. Guest listeners see an honest empty state — the
// import through /api/playlists/import stays exactly as it is today.

import { setRequestLocale } from "next-intl/server";
import { PlaylistsView } from "./PlaylistsView";

export default async function PlaylistsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <PlaylistsView />;
}
