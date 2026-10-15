// H-120 task 3: the ONE navigation config. Every destination has an
// `enabled` flag — an item whose page does not exist yet is not rendered;
// later naryads switch their own flag on (H-121: playlists; H-122: me;
// search arrives with its own card). Add an item HERE and set the flag
// when its page ships (see docs/UI.md).

export type NavItem = {
  /** Stable key — also the message key under "nav". */
  key: "radio" | "charts" | "search" | "playlists" | "me";
  /** Locale-relative href (the leading /<locale> segment is added by Link). */
  href: string;
  /** Does the page exist and ship? Off until its naryad lands. */
  enabled: boolean;
};

export const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { key: "radio", href: "/", enabled: true },
  { key: "charts", href: "/charts", enabled: true },
  { key: "search", href: "/search", enabled: false },
  { key: "playlists", href: "/playlists", enabled: false },
  { key: "me", href: "/me", enabled: false },
];

/** The items a navigator renders right now. */
export function enabledNavItems(): NavItem[] {
  return NAV_ITEMS.filter((item) => item.enabled);
}

/**
 * True when `pathname` is the active page of `item`. "/" is active only
 * exactly; the rest match by prefix (the locale segment is already
 * stripped by the caller).
 */
export function isNavItemActive(item: NavItem, pathnameWithoutLocale: string): boolean {
  if (item.href === "/") return pathnameWithoutLocale === "/" || pathnameWithoutLocale === "";
  return pathnameWithoutLocale === item.href || pathnameWithoutLocale.startsWith(`${item.href}/`);
}
