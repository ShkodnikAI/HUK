"use client";

// The comment block under the player (H-303). Comment text is untrusted
// data (S5): it is rendered as text only — never as HTML, never through
// dangerouslySetInnerHTML. The thread shows VISIBLE comments to everyone;
// the author additionally sees their own HELD comments with the
// "waiting for review" flag and their own hidden/removed comments with
// the moderator's statement of reasons. New comments are HELD until a
// moderator approves them (Owner decision 2026-10-08, option (a)) — the
// composer says so up front.

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

export type CommentView = {
  id: string;
  parentId: string | null;
  body: string;
  createdAt: string;
  mine: boolean;
  waitingForReview?: boolean;
  statementOfReasons?: string | null;
};

type ThreadState =
  | { kind: "loading" }
  | { kind: "ready"; comments: ThreadComment[]; nextCursor: string | null }
  | { kind: "error"; message: string };

const EDIT_WINDOW_MS = 10 * 60 * 1000;

async function jsonFetch(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetch(url, { credentials: "same-origin", ...init });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

export type ThreadComment = CommentView & { canEdit: boolean };

export function CommentsThread({ trackId }: { trackId: string }) {
  const t = useTranslations("comments");
  const [state, setState] = useState<ThreadState>({ kind: "loading" });
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await jsonFetch(`/api/tracks/${encodeURIComponent(trackId)}/comments?limit=20`);
    if (!res.ok) {
      setState({ kind: "error", message: t("loadFailed") });
      return;
    }
    const body = res.body as { comments?: CommentView[]; nextCursor?: string | null };
    // The 10-minute edit window is computed at load time (never during render).
    const atLoad = Date.now();
    setState({
      kind: "ready",
      comments: (body.comments ?? []).map((c) => ({
        ...c,
        canEdit: c.mine && atLoad - new Date(c.createdAt).getTime() <= EDIT_WINDOW_MS,
      })),
      nextCursor: body.nextCursor ?? null,
    });
  }, [trackId, t]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await jsonFetch(`/api/tracks/${encodeURIComponent(trackId)}/comments?limit=20`);
      if (cancelled) return;
      if (!res.ok) {
        setState({ kind: "error", message: t("loadFailed") });
        return;
      }
      const body = res.body as { comments?: CommentView[]; nextCursor?: string | null };
      // The 10-minute edit window is computed at load time (never during render).
      const atLoad = Date.now();
      setState({
        kind: "ready",
        comments: (body.comments ?? []).map((c) => ({
          ...c,
          canEdit: c.mine && atLoad - new Date(c.createdAt).getTime() <= EDIT_WINDOW_MS,
        })),
        nextCursor: body.nextCursor ?? null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [trackId, t]);

  const post = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    const res = await jsonFetch(`/api/tracks/${encodeURIComponent(trackId)}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: draft, ...(replyTo ? { parentId: replyTo } : {}) }),
    });
    setBusy(false);
    if (res.status === 401) {
      setNotice(t("signInToComment"));
      return;
    }
    if (res.status === 429) {
      setNotice(t("errorRateLimited"));
      return;
    }
    if (res.status === 403) {
      const code = (res.body as { error?: { code?: string } })?.error?.code;
      setNotice(code === "ACCOUNT_TOO_NEW" ? t("errorAccountTooNew") : t("errorNotVerified"));
      return;
    }
    if (!res.ok) {
      const code = (res.body as { error?: { code?: string } })?.error?.code;
      setNotice(code === "LINK_FORBIDDEN" ? t("errorLink") : code === "BODY_TOO_LONG" ? t("errorTooLong") : t("actionFailed"));
      return;
    }
    setDraft("");
    setReplyTo(null);
    setNotice(t("waitingForReview"));
    await load();
  };

  const saveEdit = async (commentId: string): Promise<void> => {
    setBusy(true);
    const res = await jsonFetch(`/api/comments/${encodeURIComponent(commentId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: editDraft }),
    });
    setBusy(false);
    if (!res.ok) {
      setNotice(res.status === 403 ? t("errorEditWindow") : t("actionFailed"));
      return;
    }
    setEditing(null);
    setNotice(t("waitingForReview"));
    await load();
  };

  const remove = async (commentId: string): Promise<void> => {
    setBusy(true);
    const res = await jsonFetch(`/api/comments/${encodeURIComponent(commentId)}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) {
      setNotice(t("actionFailed"));
      return;
    }
    await load();
  };

  const report = async (commentId: string): Promise<void> => {
    setBusy(true);
    const res = await jsonFetch(`/api/reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetType: "COMMENT", targetId: commentId, reason: t("reportReason") }),
    });
    setBusy(false);
    setNotice(res.ok ? t("reported") : t("actionFailed"));
  };

  const topLevel = state.kind === "ready" ? state.comments.filter((c) => c.parentId === null) : [];
  const repliesOf = (id: string): ThreadComment[] =>
    state.kind === "ready" ? state.comments.filter((c) => c.parentId === id) : [];

  const editable = (c: ThreadComment): boolean => c.canEdit && c.statementOfReasons === undefined;

  const renderItem = (c: ThreadComment, depth: 0 | 1) => (
    <li key={c.id} className={depth === 1 ? "ml-6 border-l border-neutral-700 pl-3" : "mt-3"}>
      <p className="text-sm text-neutral-200">
        {/* Untrusted text rendered as text only (S5). */}
        {c.body}
      </p>
      <p className="mt-1 text-xs text-neutral-500">
        {new Date(c.createdAt).toLocaleString()}
        {c.waitingForReview ? ` · ${t("waitingForReview")}` : ""}
        {c.statementOfReasons ? ` · ${t("moderatedWithReason", { reason: c.statementOfReasons })}` : ""}
      </p>
      {c.mine && editing === c.id ? (
        <span className="mt-1 flex gap-2">
          <input
            type="text"
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
            maxLength={500}
            className="w-full rounded border border-neutral-600 bg-neutral-900 px-2 py-1 text-sm"
          />
          <button type="button" disabled={busy} onClick={() => void saveEdit(c.id)} className="text-sm text-[#D4AF37]">
            {t("save")}
          </button>
          <button type="button" onClick={() => setEditing(null)} className="text-sm text-neutral-400">
            {t("cancel")}
          </button>
        </span>
      ) : (
        <span className="mt-1 flex flex-wrap gap-3 text-xs">
          {depth === 0 && (
            <button type="button" onClick={() => { setReplyTo(c.id); setNotice(null); }} className="text-neutral-400">
              {t("reply")}
            </button>
          )}
          {c.mine && editable(c) && (
            <button
              type="button"
              onClick={() => { setEditing(c.id); setEditDraft(c.body); }}
              className="text-neutral-400"
            >
              {t("edit")}
            </button>
          )}
          {c.mine && (
            <button type="button" disabled={busy} onClick={() => void remove(c.id)} className="text-neutral-400">
              {t("delete")}
            </button>
          )}
          {!c.mine && (
            <button type="button" disabled={busy} onClick={() => void report(c.id)} className="text-neutral-500">
              {t("report")}
            </button>
          )}
        </span>
      )}
      {repliesOf(c.id).map((r) => renderItem(r, 1))}
    </li>
  );

  return (
    <section aria-label={t("title")} className="mt-4 w-full text-left">
      <h3 className="text-sm font-semibold text-neutral-300">{t("title")}</h3>
      <p className="mt-1 text-xs text-neutral-500">{t("heldNotice")}</p>
      {replyTo && (
        <p className="text-xs text-neutral-400">
          {t("replyingTo")}
          {" "}
          <button type="button" onClick={() => setReplyTo(null)} className="underline">
            {t("cancel")}
          </button>
        </p>
      )}
      <span className="mt-2 flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={500}
          placeholder={t("placeholder")}
          className="w-full rounded border border-neutral-600 bg-neutral-900 px-2 py-1 text-sm"
        />
        <button type="button" disabled={busy || draft.trim().length === 0} onClick={() => void post()} className="rounded border px-3 py-1 text-sm">
          {t("submit")}
        </button>
      </span>
      {notice && <p className="mt-1 text-xs text-[#D4AF37]">{notice}</p>}
      {state.kind === "ready" && state.comments.length === 0 && <p className="mt-2 text-sm text-neutral-400">{t("empty")}</p>}
      <ul className="mt-2 list-none">{topLevel.map((c) => renderItem(c, 0))}</ul>
    </section>
  );
}
