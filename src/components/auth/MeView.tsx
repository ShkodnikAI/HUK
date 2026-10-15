"use client";

// H-122 task 6: the Me tab, minimal. Signed out: a sign-in button.
// Signed in: the email, the role in words, "Sign out" (the Auth.js own
// CSRF handshake), and the invite link only for a listener while the beta
// is invite-only. The data screen link is intentionally absent — H-214
// delivers that page. The server page (me/page.tsx) resolves the session
// and passes plain props.

import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Chip";

export type MeViewProps = {
  signedIn: boolean;
  email?: string | null;
  role?: string | null;
  /** A listener (no ARTIST/ADMIN role) while INVITE_ONLY is on. */
  inviteApplicable?: boolean;
};

export function MeView({ signedIn, email, role, inviteApplicable = false }: MeViewProps) {
  const t = useTranslations("auth.me");
  const locale = useLocale();
  const router = useRouter();

  const signOut = async (): Promise<void> => {
    // Auth.js sign-out: the provider's own CSRF handshake, then reload.
    const csrfRes = await fetch("/api/auth/csrf", { cache: "no-store" });
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
    const form = new FormData();
    form.set("csrfToken", csrfToken);
    await fetch("/api/auth/signout", { method: "POST", body: form });
    router.refresh();
  };

  if (!signedIn) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col gap-4">
        <h1 className="font-display text-3xl font-semibold">{t("title")}</h1>
        <Card>
          <p className="text-sm text-muted">{t("signedOutText")}</p>
          <Link href={`/${locale}/signin`} className="focus-gold mt-4 inline-flex rounded-xl">
            <Button>{t("signIn")}</Button>
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <h1 className="font-display text-3xl font-semibold">{t("title")}</h1>
      <Card>
        <p className="text-sm text-muted">{t("emailLabel")}</p>
        <p className="text-text">{email}</p>
        <p className="mt-3 text-sm text-muted">{t("roleLabel")}</p>
        <p className="text-text">{role}</p>
        {inviteApplicable && (
          <Link
            href={`/${locale}/invite`}
            className="focus-gold mt-4 inline-flex min-h-[44px] items-center rounded-xl bg-gold px-4 font-semibold text-background hover:brightness-110"
          >
            {t("inviteLink")}
          </Link>
        )}
        <div className="mt-4">
          <Button variant="secondary" onClick={() => void signOut()}>
            {t("signOut")}
          </Button>
        </div>
      </Card>
    </div>
  );
}
