#!/bin/sh
# deploy/check-env.sh (H-504) — pre-flight gate for the production stack.
#
# Parses the env file WITHOUT executing it and refuses to start (exit 1) when
# a secret is empty, still equals a dev default, or a URL is not a real
# https origin (S8 fail loud, S9 fail closed). deploy/up.sh and update.sh run
# this before touching Docker.
#
# Usage: deploy/check-env.sh [path-to-env-file]   (default: deploy/.env)
set -eu

SELF_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ENV_FILE=${1:-"$SELF_DIR/.env"}

if [ ! -f "$ENV_FILE" ]; then
  echo "FAIL: env file not found: $ENV_FILE" >&2
  echo "      copy deploy/.env.production.example to deploy/.env and fill it first" >&2
  exit 1
fi

# Parse KEY=VALUE lines defensively: skip blank lines and comments, strip
# inline comments after a whitespace '#', strip one pair of surrounding
# quotes. Output is KEY<TAB>VALUE read by get() — no eval, ever.
PARSED=$(mktemp)
trap 'rm -f "$PARSED"' EXIT
LC_ALL=C awk -v sq="'" '
  /^[[:space:]]*#/ { next }
  /^[[:space:]]*$/ { next }
  {
    line = $0
    sub(/[[:space:]]+#.*$/, "", line)
    sub(/^[[:space:]]+/, "", line)
    eq = index(line, "=")
    if (eq < 2) next
    key = substr(line, 1, eq - 1)
    val = substr(line, eq + 1)
    n = length(val)
    a = substr(val, 1, 1)
    b = substr(val, n, 1)
    if (n >= 2 && ((a == "\"" && b == "\"") || (a == sq && b == sq)))
      val = substr(val, 2, n - 2)
    printf "%s\t%s\n", key, val
  }
' "$ENV_FILE" > "$PARSED"

get() {
  awk -F'\t' -v k="$1" '$1 == k { print substr($0, index($0, "\t") + 1); exit }' "$PARSED"
}

problems=0
bad() {
  echo "FAIL: $*" >&2
  problems=$((problems + 1))
}

# --- Required non-empty ---
for k in POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB AUTH_SECRET NEXTAUTH_URL \
         IP_HASH_SALT CLIENT_IP_HEADER EMAIL_SERVER EMAIL_FROM \
         SEED_AUDIO_BASE_URL CLOUDFLARE_TUNNEL_TOKEN HUK_BACKUP_DIR; do
  [ -n "$(get "$k")" ] || bad "$k is empty"
done

# --- Secret strength and dev-default refusals ---
v=$(get AUTH_SECRET)
[ ${#v} -ge 32 ] || bad "AUTH_SECRET must be at least 32 chars (openssl rand -base64 32)"

v=$(get POSTGRES_PASSWORD)
[ "$v" != "huk" ] || bad "POSTGRES_PASSWORD is the dev default 'huk'"
[ ${#v} -ge 16 ] || bad "POSTGRES_PASSWORD must be at least 16 chars (openssl rand -hex 16)"
# The compose file interpolates this password into DATABASE_URL — a character
# outside the URL-unreserved set (base64 `/`, `+`, `=`, or any `@:?#%`) breaks
# the URL at boot (prisma P1013, seen in CI). Refuse it here, loudly.
case "$v" in
  *[!A-Za-z0-9._~-]*) bad "POSTGRES_PASSWORD must be URL-safe ([A-Za-z0-9._~-]) — it is embedded into DATABASE_URL (generate: openssl rand -hex 16)" ;;
esac

v=$(get IP_HASH_SALT)
[ "$v" != "huk-dev-ip-hash-salt-do-not-use-in-prod" ] || bad "IP_HASH_SALT is the dev default (H-103)"
[ ${#v} -ge 16 ] || bad "IP_HASH_SALT must be at least 16 chars (openssl rand -base64 24)"

# --- NEXTAUTH_URL: real https origin (H-110) ---
v=$(get NEXTAUTH_URL)
case "$v" in
  https://*) ;;
  *) bad "NEXTAUTH_URL must start with https:// (got: $v) (H-110)" ;;
esac
host=$(printf '%s' "$v" | sed -e 's#^[a-z]*://##' -e 's#[:/].*$##')
case "$host" in
  localhost|127.0.0.1|::1|*.local|example.com|*.example.com|example.org|*.example.org)
    bad "NEXTAUTH_URL host must be the real public domain, not '$host' (H-110)" ;;
esac

# --- EMAIL: no application default, no dev sink ---
v=$(get EMAIL_FROM)
case "$v" in
  *@example.com*) bad "EMAIL_FROM still ends in @example.com (application default)" ;;
esac
v=$(get EMAIL_SERVER)
case "$v" in
  *mailpit*) bad "EMAIL_SERVER points at the dev mailpit sink" ;;
esac

# --- Seed audio: absolute https URL in production (H-106/H-504) ---
v=$(get SEED_AUDIO_BASE_URL)
case "$v" in
  https://*) ;;
  *) bad "SEED_AUDIO_BASE_URL must be an absolute https:// URL in production (got: $v)" ;;
esac

# --- Audio cache: absolute, outside any served public directory (S3/H-112) ---
v=$(get AUDIO_CACHE_DIR)
if [ -n "$v" ]; then
  case "$v" in
    /*) ;;
    *) bad "AUDIO_CACHE_DIR must be an absolute path (got: $v)" ;;
  esac
  case "$v" in
    */public/*|*/public) bad "AUDIO_CACHE_DIR must not be inside a served public directory (S3)" ;;
  esac
fi

# --- Cloudflare tunnel token: refuse obvious placeholders ---
v=$(get CLOUDFLARE_TUNNEL_TOKEN)
case "$v" in
  changeme|CHANGEME|paste-token-here|xxx|test) bad "CLOUDFLARE_TUNNEL_TOKEN is still a placeholder" ;;
esac

# --- First-admin bootstrap (H-102): optional, so only a note, never a refusal ---
v=$(get INITIAL_ADMIN_EMAIL)
if [ -z "$v" ]; then
  echo "NOTE: INITIAL_ADMIN_EMAIL is empty — the stack boots, but the first-admin bootstrap stays disabled (H-102)"
fi

# --- Deployment knobs ---
v=$(get HUK_WEB_PORT)
if [ -n "$v" ]; then
  case "$v" in
    *[!0-9]*) bad "HUK_WEB_PORT must be numeric (got: $v)" ;;
    *)
      # Intentional: bad() runs exactly when the conjunction fails.
      # shellcheck disable=SC2015
      [ "$v" -ge 1 ] && [ "$v" -le 65535 ] || bad "HUK_WEB_PORT out of range 1-65535 (got: $v)"
      ;;
  esac
fi
v=$(get HUK_BACKUP_DIR)
case "$v" in
  /*) ;;
  *) bad "HUK_BACKUP_DIR must be an absolute host path (got: $v)" ;;
esac

if [ "$problems" -gt 0 ]; then
  echo "$ENV_FILE: $problems problem(s) — refusing to start (S8/S9)" >&2
  exit 1
fi
echo "$ENV_FILE: OK (S8 pre-flight passed)"
