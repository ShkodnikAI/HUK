// H-122: the localised entry — the same screen under the [locale] layout
// (used by in-app links; Auth.js itself lands on the non-localised path).
import { CheckEmailScreen } from "@/components/auth/CheckEmailScreen";

export default function Page() {
  return <CheckEmailScreen />;
}
