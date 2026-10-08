"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { buildReportActionRequest, performRequest } from "./actions";

// Report resolution actions (H-207): dismiss, takedown, restrict by
// country (track targets) and ban (user targets — a human decision with a
// mandatory statement of reasons). All through the existing H-206 API.

type ReportAction = "DISMISS" | "TAKEDOWN" | "RESTRICT" | "BAN";

export function ReportActions({ reportId, targetType }: { reportId: string; targetType: string }) {
  const t = useTranslations("mod");
  const [reason, setReason] = useState("");
  const [country, setCountry] = useState("");
  const [days, setDays] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isUserTarget = targetType === "USER";
  const isTrackTarget = targetType === "TRACK";

  const actions: Array<{ action: ReportAction; disabled: boolean }> = [
    { action: "DISMISS", disabled: reason.trim().length === 0 },
    { action: "TAKEDOWN", disabled: !isTrackTarget || reason.trim().length === 0 },
    { action: "RESTRICT", disabled: !isTrackTarget || reason.trim().length === 0 || !/^[A-Za-z]{2}$/.test(country) },
    { action: "BAN", disabled: !isUserTarget || reason.trim().length === 0 || Number(days) < 1 },
  ];

  const run = async (action: ReportAction): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const built =
        action === "RESTRICT"
          ? buildReportActionRequest({ action, reportId, statementOfReasons: reason, countryCode: country.toUpperCase() })
          : action === "BAN"
            ? buildReportActionRequest({ action, reportId, statementOfReasons: reason, banDays: Number(days) })
            : buildReportActionRequest({ action, reportId, statementOfReasons: reason });
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
      {actions.map(({ action, disabled }) => (
        <button
          key={action}
          type="button"
          disabled={busy || disabled}
          onClick={() => void run(action)}
          className="rounded border px-3 py-1 text-sm hover:bg-neutral-800 disabled:opacity-50"
          title={t("reasonRequired")}
        >
          {t(action.toLowerCase())}
        </button>
      ))}
      {isTrackTarget ? (
        <input
          type="text"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          placeholder={t("countryPlaceholder")}
          maxLength={2}
          className="w-16 rounded border bg-transparent px-2 py-1 text-sm"
          aria-label={t("country")}
        />
      ) : null}
      {isUserTarget ? (
        <input
          type="number"
          min={1}
          value={days}
          onChange={(e) => setDays(e.target.value)}
          className="w-20 rounded border bg-transparent px-2 py-1 text-sm"
          aria-label={t("banDays")}
        />
      ) : null}
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
