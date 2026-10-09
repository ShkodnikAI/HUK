"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { buildCommentActionRequest, performRequest } from "./actions";

// Comment moderation actions (H-303): approve (publish), hide and remove
// — hide and remove with a mandatory statement of reasons that reaches
// the commenter through their own-comments view. All through the
// H-303 API POST /api/mod/comments/:id.

type CommentAction = "APPROVE" | "HIDE" | "REMOVE";

export function CommentActions({ commentId }: { commentId: string }) {
  const t = useTranslations("mod");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsReason = (action: CommentAction): boolean => action !== "APPROVE";
  const disabled = (action: CommentAction): boolean => busy || (needsReason(action) && reason.trim().length === 0);

  const run = async (action: CommentAction): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const built = buildCommentActionRequest(
        action === "APPROVE" ? { action, commentId } : { action, commentId, reason },
      );
      const result = await performRequest(built);
      if (!result.ok) {
        setError(t("actionFailed", { status: result.status }));
        return;
      }
      window.location.reload();
    } catch {
      setError(t("actionFailed", { status: 0 }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-start gap-2">
      {(["APPROVE", "HIDE", "REMOVE"] as const).map((action) => (
        <button
          key={action}
          type="button"
          disabled={disabled(action)}
          onClick={() => void run(action)}
          className="rounded border px-3 py-1 text-sm hover:bg-neutral-800 disabled:opacity-50"
          title={needsReason(action) ? t("reasonRequired") : undefined}
        >
          {t(`comment_${action.toLowerCase()}`)}
        </button>
      ))}
      <input
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={t("reasonPlaceholder")}
        maxLength={2000}
        className="min-w-64 flex-1 rounded border bg-transparent px-2 py-1 text-sm"
        aria-label={t("reason")}
      />
      {error ? <span className="text-sm text-red-400">{error}</span> : null}
    </div>
  );
}
