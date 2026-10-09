// DELETE /api/me (H-214, S7): erase the account. Origin-checked by the
// guard (F12); the body must carry { confirmEmail } equal to the account
// email — anything else is a 403 and changes nothing. The erasure runs in
// one transaction (see the service); the caller's own tracks are taken
// down with the reason author-withdrew and leave the air. Deleted users
// are refused by the guard afterwards, so a second delete is a no-op.

import { parseJson } from "@/server/http/parse";
import { requireUser } from "@/server/guard";
import { route } from "@/server/http/handler";
import { deleteAccount, deleteAccountSchema } from "@/server/account/service";

export const dynamic = "force-dynamic";

export const DELETE = route(async (req) => {
  const { user } = await requireUser(req);
  const input = await parseJson(req, deleteAccountSchema);
  const result = await deleteAccount(user, input);
  return Response.json(result, { status: 200 });
});
