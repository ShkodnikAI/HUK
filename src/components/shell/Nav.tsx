"use client";

// H-120 task 3: the navigators. Client components (they read the current
// path to mark the active destination with aria-current="page"). The item
// set comes from the one config (shell/nav.ts) — disabled destinations are
// NOT rendered. Tap targets are at least 44 px (TOKENS.md) on both bars.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { enabledNavItems, isNavItemActive, type NavItem } from "./nav";

const LINK_CLASSES =
  "focus-gold inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-lg px-3 text-sm font-medium text-muted transition-colors hover:text-text";

function navLinkClasses(active: boolean): string {
  return active ? `${LINK_CLASSES} bg-raised text-gold` : LINK_CLASSES;
}

function stripLocale(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length <= 1 ? "/" : `/${parts.slice(1).join("/")}`;
}

function NavLink({ item }: { item: NavItem }) {
  const t = useTranslations("nav");
  const pathname = usePathname() ?? "/";
  const active = isNavItemActive(item, stripLocale(pathname));
  return (
    <Link
      href={item.href}
      className={navLinkClasses(active)}
      aria-current={active ? "page" : undefined}
    >
      {t(item.key)}
    </Link>
  );
}

/** Desktop top bar destinations (lg and up). */
export function TopNav() {
  return (
    <nav aria-label="Main" className="hidden items-center gap-1 lg:flex">
      {enabledNavItems().map((item) => (
        <NavLink key={item.key} item={item} />
      ))}
    </nav>
  );
}

/** Phone bottom navigation (below lg): fixed, sunken surface, 44 px targets.
 *  Its landmark name differs from the top bar's (axe: landmarks unique). */
export function BottomNav() {
  const t = useTranslations("shell");
  return (
    <nav
      aria-label={t("bottomNavHint")}
      className="fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around border-t border-border bg-sunken lg:hidden"
    >
      {enabledNavItems().map((item) => (
        <NavLink key={item.key} item={item} />
      ))}
    </nav>
  );
}
