"use client";

// H-121 task 5: the playlists view. Server playlists CRUD through the
// existing routes (GET/POST /api/playlists, GET/PATCH/DELETE
// /api/playlists/[id], POST/PATCH items, DELETE items/[trackId]) — no new
// API. "Play" opens the queue in the persistent engine, switches it to
// playlist mode and returns to the radio screen; playback never stops.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { usePlayer } from "@/components/player/engine/PlayerEngine";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Chip";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { TextField } from "@/components/ui/TextField";

type PlaylistSummary = { id: string; name: string; itemCount: number };
type PlaylistItem = { trackId: string; position: number; unavailable: boolean; title: string | null };
type OpenPlaylist = { id: string; name: string; visibility: string; items: PlaylistItem[] };

type ApiError = { error?: { code?: string; message?: string } };

async function readError(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as ApiError;
    return body.error?.code ?? null;
  } catch {
    return null;
  }
}

export function PlaylistsView() {
  const t = useTranslations("playlists");
  const router = useRouter();
  const { actions } = usePlayer();
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null); // null = guest/unavailable
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenPlaylist | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/playlists", { cache: "no-store" });
      if (res.status === 401) {
        setPlaylists(null); // guest: the honest empty state
        return;
      }
      const body = (await res.json()) as { playlists?: PlaylistSummary[] };
      setPlaylists(body.playlists ?? []);
    } catch {
      setPlaylists(null);
    }
  }, []);

  useEffect(() => {
    // The initial load rides a rAF callback (no synchronous setState in an
    // effect body).
    const raf = requestAnimationFrame(() => void reload());
    return () => cancelAnimationFrame(raf);
  }, [reload]);

  const create = useCallback(async (): Promise<void> => {
    setError(null);
    if (!name.trim()) return;
    const res = await fetch("/api/playlists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    }).catch(() => null);
    if (!res) return;
    if (res.status === 201) {
      setName("");
      await reload();
      return;
    }
    const code = await readError(res);
    setError(code ?? "generic");
  }, [name, reload]);

  const renamePlaylist = useCallback(
    async (id: string, nextName: string): Promise<void> => {
      setError(null);
      const res = await fetch(`/api/playlists/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: nextName }),
      }).catch(() => null);
      if (!res) return;
      if (res.ok) {
        await reload();
        if (open?.id === id) setOpen({ ...open, name: nextName });
        return;
      }
      setError((await readError(res)) ?? "generic");
    },
    [open, reload],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      setError(null);
      const res = await fetch(`/api/playlists/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
      if (!res) return;
      if (res.ok) {
        if (open?.id === id) setOpen(null);
        await reload();
        return;
      }
      setError((await readError(res)) ?? "generic");
    },
    [open, reload],
  );

  const openDetails = useCallback(async (id: string): Promise<void> => {
    const res = await fetch(`/api/playlists/${encodeURIComponent(id)}`, { cache: "no-store" }).catch(() => null);
    if (!res || !res.ok) return;
    const body = (await res.json()) as {
      id: string;
      name: string;
      visibility: string;
      items?: Array<{ trackId: string; position: number; unavailable: boolean; title?: string }>;
    };
    setOpen({
      id: body.id,
      name: body.name,
      visibility: body.visibility,
      items: (body.items ?? []).map((i) => ({
        trackId: i.trackId,
        position: i.position,
        unavailable: i.unavailable,
        title: i.unavailable ? null : (i.title ?? null),
      })),
    });
  }, []);

  const removeItem = useCallback(
    async (playlistId: string, trackId: string): Promise<void> => {
      const res = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}/items/${encodeURIComponent(trackId)}`, {
        method: "DELETE",
      }).catch(() => null);
      if (res?.ok) await openDetails(playlistId);
    },
    [openDetails],
  );

  const reorder = useCallback(
    async (playlistId: string, trackIds: string[]): Promise<void> => {
      const res = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}/items`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trackIds }),
      }).catch(() => null);
      if (res?.ok) await openDetails(playlistId);
    },
    [openDetails],
  );

  const play = useCallback(
    async (playlistId: string): Promise<void> => {
      await actions.openQueue(playlistId);
      actions.setMode("playlist");
      await actions.startPlaylistItem(0);
      router.push("/");
    },
    [actions, router],
  );

  const move = useCallback(
    (playlistId: string, index: number, delta: -1 | 1) => {
      if (!open) return;
      const ids = open.items.map((i) => i.trackId);
      const target = index + delta;
      if (target < 0 || target >= ids.length) return;
      [ids[index], ids[target]] = [ids[target], ids[index]];
      void reorder(playlistId, ids);
    },
    [open, reorder],
  );

  const errorText = (code: string | null): string => {
    switch (code) {
      case "PLAYLIST_LIMIT":
        return t("limitReached");
      case "PLAYLIST_FULL":
        return t("playlistFull");
      case "ALREADY_IN_PLAYLIST":
        return t("alreadyInPlaylist");
      case "TEXT_REJECTED":
        return t("textRejected");
      default:
        return t("genericError");
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5">
      <h1 className="font-display text-3xl font-semibold">{t("title")}</h1>
      {error && (
        <p role="alert" className="rounded-xl bg-danger-bg px-3 py-2 text-sm text-danger">
          {errorText(error)}
        </p>
      )}

      {/* Create (signed-in only — guests get the honest empty state below). */}
      {playlists !== null && (
        <Card>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <TextField
              label={t("newName")}
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              helpText={t("nameHelp")}
            />
            <Button type="submit" className="self-start">
              {t("create")}
            </Button>
          </form>
        </Card>
      )}

      {playlists === null ? (
        <Card>
          <p className="text-sm text-muted">{t("emptyGuest")}</p>
        </Card>
      ) : playlists.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">{t("empty")}</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {playlists.map((p) => (
            <li key={p.id}>
              <Card className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="focus-gold min-h-[44px] flex-1 rounded-lg px-2 text-left"
                  onClick={() => void openDetails(p.id)}
                  aria-expanded={open?.id === p.id}
                >
                  <span className="font-medium text-text">{p.name}</span>{" "}
                  <span className="text-sm text-muted">
                    {t("itemCount", { count: p.itemCount })}
                  </span>
                </button>
                <Button variant="secondary" onClick={() => void play(p.id)} disabled={p.itemCount === 0}>
                  {t("play")}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    const next = window.prompt(t("renamePrompt"), p.name);
                    if (next && next !== p.name) void renamePlaylist(p.id, next);
                  }}
                >
                  {t("rename")}
                </Button>
                <Button variant="ghost" onClick={() => void remove(p.id)}>
                  {t("delete")}
                </Button>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <Card>
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-display text-xl font-semibold">{open.name}</h2>
            <StatusBadge tone="pending">{open.visibility.toLowerCase()}</StatusBadge>
          </div>
          {open.items.length === 0 ? (
            <p className="mt-3 text-sm text-muted">{t("emptyPlaylist")}</p>
          ) : (
            <ol className="mt-3 space-y-1">
              {open.items.map((item, index) => (
                <li key={item.trackId} className="flex items-center gap-2 rounded-lg px-1 py-1">
                  <span className="w-6 text-right text-xs text-muted">{index + 1}</span>
                  <span className={`min-w-0 flex-1 truncate text-sm ${item.unavailable ? "text-muted" : "text-text"}`}>
                    {item.unavailable ? t("unavailable") : (item.title ?? "")}
                  </span>
                  <Button variant="ghost" onClick={() => move(open.id, index, -1)} disabled={index === 0}>
                    {t("iconUp")}<span className="sr-only">{t("moveUp")}</span>
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => move(open.id, index, 1)}
                    disabled={index === open.items.length - 1}
                  >
                    {t("iconDown")}<span className="sr-only">{t("moveDown")}</span>
                  </Button>
                  <Button variant="ghost" onClick={() => void removeItem(open.id, item.trackId)}>
                    {t("remove")}
                  </Button>
                </li>
              ))}
            </ol>
          )}
          <Button variant="ghost" className="mt-3" onClick={() => setOpen(null)}>
            {t("close")}
          </Button>
        </Card>
      )}
    </div>
  );
}
