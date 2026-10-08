"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { buildTrackActionRequest, performRequest } from "./actions";

// Track decision actions (H-207): approve, reject (reason required),
// restrict by country. Every button builds its request through the pure
// per-action builders and POSTs to the existing API, then refreshes so the
// server-rendered queues re-read.

type TrackAction = "APPROVE" | "REJECT" | "RESTRICT";

export function TrackActions({ trackId }: { trackId: string }) {
  const t = useTranslations("mod");
  const [reason, setReason] = useState("");
  const [country, setCountry] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: TrackAction): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const built =
        action === "APPROVE"
          ? buildTrackActionRequest({ action, trackId })
          : action === "REJECT"
            ? buildTrackActionRequest({ action, trackId, reason })
            : buildTrackActionRequest({ action, trackId, reason, countryCode: country.toUpperCase() });
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
      <button
        type="button"
        disabled={busy}
        onClick={() => void run("APPROVE")}
        className="rounded border px-3 py-1 text-sm hover:bg-neutral-800 disabled:opacity-50"
      >
        {t("approve")}
      </button>
      <button
        type="button"
        disabled={busy || reason.trim().length === 0}
        onClick={() => void run("REJECT")}
        className="rounded border px-3 py-1 text-sm hover:bg-neutral-800 disabled:opacity-50"
        title={t("reasonRequired")}
      >
        {t("reject")}
      </button>
      <button
        type="button"
        disabled={busy || reason.trim().length === 0 || !/^[A-Za-z]{2}$/.test(country)}
        onClick={() => void run("RESTRICT")}
        className="rounded border px-3 py-1 text-sm hover:bg-neutral-800 disabled:opacity-50"
        title={t("reasonRequired")}
      >
        {t("restrict")}
      </button>
      <input
        type="text"
        value={country}
        onChange={(e) => setCountry(e.target.value)}
        placeholder={t("countryPlaceholder")}
        maxLength={2}
        className="w-16 rounded border bg-transparent px-2 py-1 text-sm"
        aria-label={t("country")}
      />
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
