// H-122: the NON-localised page Auth.js redirects to (the pages option in
// src/server/auth/options.ts). The locale bridge resolves the locale from
// the NEXT_LOCALE cookie / Accept-Language in place — a redirect here
// would lose Auth.js's query parameters.
import { LocaleBridge } from "@/components/auth/LocaleBridge";
import { AuthErrorScreen } from "@/components/auth/AuthErrorScreen";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <LocaleBridge>
      <AuthErrorScreen />
    </LocaleBridge>
  );
}
