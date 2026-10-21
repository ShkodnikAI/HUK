#!/bin/sh
# k8s/tests/check-env.test.sh (H-504, Kubernetes edition) — tests for
# k8s/check-env.sh.
#
# Covers the four cases the naryad requires (empty secret, dev default,
# http URL, good file) plus the refusal rules added by the Auditor's
# Domain amendment (EMAIL_FROM @example.com, dev mailpit sink, localhost
# host, dev Postgres password, public-segment cache dir, placeholder tunnel
# token) and the Kubernetes additions (DATABASE_URL scheme and in-cluster
# host, and the bare KEY=value rule — kubectl --from-env-file keeps quotes
# literally). Runs on POSIX sh, no dependencies.
# Wired into the `invariants` CI job (task 7 of H-504).
set -eu

SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
CHECK_ENV="$SELF_DIR/../check-env.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

GOOD="$TMP/good.env"
cat > "$GOOD" <<'EOF'
POSTGRES_USER=huk
POSTGRES_PASSWORD=drill-password-not-used-anywhere-42
POSTGRES_DB=huk
DATABASE_URL=postgresql://huk:drill-password-not-used-anywhere-42@huk-postgres:5432/huk
AUTH_SECRET=drill-auth-secret-not-used-anywhere-000000000042
NEXTAUTH_URL=https://hukradio.com
IP_HASH_SALT=drill-ip-hash-salt-not-used-anywhere-42
CLIENT_IP_HEADER=cf-connecting-ip
EMAIL_SERVER=smtp://drill:drill@smtp.drill.invalid:587
EMAIL_FROM=HUK <no-reply@hukradio.com>
SEED_AUDIO_BASE_URL=https://hukradio.com/seed
AUDIO_CACHE_DIR=/var/lib/huk/audio-cache
CLOUDFLARE_TUNNEL_TOKEN=drill-tunnel-token-not-used-anywhere-42
HUK_WEB_PORT=3100
EOF

pass=0
fail=0

expect_ok() {
  if sh "$CHECK_ENV" "$1" > /dev/null 2>&1; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "NOT OK  (expected pass): $2"
  fi
}

expect_fail() {
  if sh "$CHECK_ENV" "$1" > /dev/null 2>&1; then
    fail=$((fail + 1))
    echo "PASSED  (expected refusal): $2"
  else
    pass=$((pass + 1))
  fi
}

# Mutate one value in the good file into $TMP/variant.env (bare values —
# quoting is refused by design, see the quoted-value test below).
variant() {
  awk -v k="$1" -v nv="$2" -F= '
    $1 == k { print k "=" nv; next }
    { print }
  ' "$GOOD" > "$TMP/variant.env"
}

# 1. good file -> pass
expect_ok "$GOOD" "a complete, non-default file passes"

# 1a. quoted values are refused: kubectl --from-env-file keeps quotes
#     literally (the kind drill saw ALTER USER ""huk"")
sed 's/^POSTGRES_USER=huk$/POSTGRES_USER="huk"/' "$GOOD" > "$TMP/quoted.env"
expect_fail "$TMP/quoted.env" "quoted values are refused"

# 2. empty secret (AUTH_SECRET)
variant AUTH_SECRET ""
expect_fail "$TMP/variant.env" "empty AUTH_SECRET is refused"

# 3. dev default (IP_HASH_SALT)
variant IP_HASH_SALT "huk-dev-ip-hash-salt-do-not-use-in-prod"
expect_fail "$TMP/variant.env" "dev IP_HASH_SALT is refused"

# 3a. POSTGRES_PASSWORD not URL-safe: a base64 `/` breaks the DATABASE_URL
#     it is embedded into (prisma P1013, caught by the deploy drill).
variant POSTGRES_PASSWORD "base64/with/slashes-42"
expect_fail "$TMP/variant.env" "non-URL-safe POSTGRES_PASSWORD is refused"

# 3c. DATABASE_URL must point at the in-cluster Service, never localhost
variant DATABASE_URL "postgresql://huk:drill-password-not-used-anywhere-42@localhost:5432/huk"
expect_fail "$TMP/variant.env" "localhost DATABASE_URL host is refused"

# 3d. DATABASE_URL must be a postgresql:// URL
variant DATABASE_URL "mysql://huk:drill-password-not-used-anywhere-42@huk-postgres:5432/huk"
expect_fail "$TMP/variant.env" "non-postgresql DATABASE_URL is refused"

# 3b. a URL-safe hex password passes the same gate
variant POSTGRES_PASSWORD "4f1c9b2e7a5d3f806c2e1b9a7d5f3c48"
expect_ok "$TMP/variant.env" "URL-safe hex POSTGRES_PASSWORD passes"

# 4. http URL (NEXTAUTH_URL)
variant NEXTAUTH_URL "http://hukradio.com"
expect_fail "$TMP/variant.env" "http:// NEXTAUTH_URL is refused"

# extra refusals required by the Domain amendment
variant EMAIL_FROM "HUK <no-reply@example.com>"
expect_fail "$TMP/variant.env" "EMAIL_FROM @example.com is refused"

variant EMAIL_SERVER "smtp://mailpit:1025"
expect_fail "$TMP/variant.env" "dev mailpit EMAIL_SERVER is refused"

variant NEXTAUTH_URL "https://localhost:3000"
expect_fail "$TMP/variant.env" "localhost NEXTAUTH_URL host is refused"

variant POSTGRES_PASSWORD "huk"
expect_fail "$TMP/variant.env" "dev Postgres password is refused"

variant CLOUDFLARE_TUNNEL_TOKEN ""
expect_fail "$TMP/variant.env" "empty tunnel token is refused"

variant AUDIO_CACHE_DIR "/srv/public/cache"
expect_fail "$TMP/variant.env" "AUDIO_CACHE_DIR inside a public segment is refused"

# missing env file
expect_fail "$TMP/does-not-exist.env" "missing env file is refused"

echo "check-env tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
