import { defineRouting } from "next-intl/routing";

// H-105: English is the default and the source of truth; Russian is the
// second locale. Routing works via the [locale] segment (no middleware —
// the platform is Node-only, see H-109), with "/" redirected to "/en".
export const routing = defineRouting({
  locales: ["en", "ru"],
  defaultLocale: "en",
});
