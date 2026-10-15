"use client";

// H-120 task 5: the offline banner. Client component listening to the
// browser online/offline events; it adds NO service worker (out of scope).
// The banner is polite live-region text at the top of the page.

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

export function OfflineBanner() {
  const t = useTranslations("states");
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  if (!offline) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="border-b border-border bg-sunken px-5 py-2 text-center text-sm text-muted"
    >
      {t("offlineText")}
    </div>
  );
}
