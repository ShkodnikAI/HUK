## Naryad
Closes #NNN  <!-- the PR body describes THIS naryad only -->

## What was done
<!-- Short: what changed and why. -->

## Fact base (verified)
<!-- file:line, commands run, output. Code, not documentation. -->

## Contracts
<!-- Tests that prove it. Which fail without the change? -->

## Same-effect paths
<!-- Output of the three greps from docs/AUDIT.md §3, or "none found" with the command. -->

## Assumptions / unresolved
<!-- Explicit. Do not present a partial result as complete. -->

## Checklist
- [ ] Scope respected (files outside the declared scope are listed here: ...)
- [ ] All blocking jobs green on the merge commit
- [ ] Every new/changed mutating route calls the guard or is in `scripts/ci/public-routes.txt` with a reason
- [ ] No non-approved content can be served by any new path (S2)
- [ ] Outbound HTTP only via `safe-fetch`; paid calls only via `budget.guard()` (S4, S6)
- [ ] New personal data: necessity, retention and deletion described (S7)
- [ ] Docs updated; known limitations added to `docs/LIMITATIONS.md`
- [ ] If an owner decision was needed, it is quoted in the issue
