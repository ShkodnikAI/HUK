// H-201: the shared case table executed by VITEST (Node runtime).
// The web container and every Node process use this path.
import { it } from "vitest";
import { cases } from "./table";

for (const c of cases) {
  it(c.name, () => c.run(), 30_000);
}
