#!/usr/bin/env bash
# Naryad H-001 — clean main for the v2 rewrite. Does NOT rewrite history (decision D7).
# Run from the repository root on a clean working tree, on a branch (e.g. h-001-cleanup).
set -euo pipefail

[ -z "$(git status --porcelain)" ] || { echo "working tree not clean"; exit 1; }
git fetch origin main --force
git log origin/main -1 --format='origin/main = %h %s'

# 1. Preserve the prototype (a tag is cheap and reversible).
#    The tag must point at a commit that REALLY contains the prototype. Default: origin/main.
#    If main was already cleaned, pass the prototype commit explicitly: PROTOTYPE_REF=24d0c33 bash scripts/cleanup-w0.sh
PROTOTYPE_REF="${PROTOTYPE_REF:-origin/main}"
git cat-file -e "$PROTOTYPE_REF:src/lib/radio.ts" 2>/dev/null || {
  echo "ERROR: $PROTOTYPE_REF does not contain src/lib/radio.ts — it is not the prototype."
  echo "Find it with: git log --all --oneline -- src/lib/radio.ts   then rerun with PROTOTYPE_REF=<sha>"
  exit 1
}
if ! git rev-parse -q --verify refs/tags/prototype-v0.2.1 >/dev/null; then
  git tag -a prototype-v0.2.1 "$PROTOTYPE_REF" -m "HUK prototype before the v2 rewrite (ADR-0001)"
  echo "tagged prototype-v0.2.1 -> $(git rev-parse --short "$PROTOTYPE_REF") (push with: git push origin prototype-v0.2.1)"
fi

# 2. Keep reusable pieces for porting (read from the prototype commit, so this also works if main was already cleaned)
mkdir -p legacy
git show "$PROTOTYPE_REF:src/hooks/use-radio.ts"              > legacy/use-radio.ts
git show "$PROTOTYPE_REF:src/components/radio/visualizer.tsx" > legacy/visualizer.tsx
git show "$PROTOTYPE_REF:scripts/gen_music.py"                > legacy/gen_music.py
# the ffprobe-based technical check is finalised by hand in H-204; this is the starting point
git show "$PROTOTYPE_REF:src/lib/moderation.ts" | sed -n '/export async function technicalCheck/,/^}/p' > legacy/technical-check.ts

# 3. Remove prototype code, data and binaries
git rm -r -q --ignore-unmatch \
  db upload src scripts/gen_jingles.py scripts/gen_music.py scripts/seed-radio.ts \
  prisma/schema.prisma public/logo.svg README.md bun.lock components.json \
  next.config.ts tailwind.config.ts postcss.config.mjs eslint.config.mjs tsconfig.json package.json .env.example
# (H-003 re-creates the app scaffold; package.json is regenerated there)

echo
echo "Next: copy the governance package files over (AGENTS.md, docs/, policy/, .github/, scripts/ci/, prisma/, README.md, .env.example, .gitignore)"
echo "Then run: node scripts/ci/check-large-files.mjs && node scripts/ci/check-docs-language.mjs"
echo "Open the PR with 'Closes #<H-001 issue>'."
