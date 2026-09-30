#!/usr/bin/env bash
# =============================================================================
#  setup-watch.sh - configure the MemorySQL upstream-watch dashboard on this box
#
#  Why this exists: the dashboard was started with env vars passed only on the
#  pm2 command line. Nothing was persisted, so a reboot / `pm2 resurrect` would
#  silently drop LLM_API_KEY (the page would just say "LLM not enabled" - no
#  error anywhere). It also had no GITHUB_TOKEN, so GitHub's anonymous 60/hour
#  limit silently degraded 11 of 12 agents to "unknown".
#
#  Usage:
#    ./setup-watch.sh <github_token>          apply
#    ./setup-watch.sh <github_token> --refresh   apply, then trigger a fetch
#    ./setup-watch.sh --verify               re-verify only, change nothing
#    ./setup-watch.sh --show                 print current config (masked)
#    ./setup-watch.sh --reset                remove GITHUB_TOKEN, keep the rest
#
#  The token is a GitHub *fine-grained* token with read access to public repos.
#  Create one at https://github.com/settings/tokens  (no scopes needed at all).
#
#  Safety rules baked in:
#    - never touches any pm2 app other than msql-upstream-watch (qa-server is
#      NOT ours and must not be disturbed)
#    - never prints a secret value in full
#    - validates the token against the GitHub API BEFORE restarting anything
#    - idempotent: safe to run repeatedly
# =============================================================================
set -euo pipefail

APP=msql-upstream-watch
PORT_DEFAULT=8788
ENVFILE="$HOME/.msql-watch-env"
TOKENFILE="$HOME/.msql-watch-token"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
amber() { printf '\033[33m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
die()   { red "ABORT: $*"; exit 1; }

mask() {
  # mask a secret: keep first 4 chars, then dots. Never print the whole thing.
  local v="$1" n=${#1}
  if [ "$n" -le 8 ]; then printf '****'; else printf '%s%s(%d chars)' "${v:0:4}" "****" "$n"; fi
}

# Snapshot the env of the LIVE process so we never lose LLM_* settings that
# were supplied on the original pm2 command line but never written to disk.
snapshot_live_env() {
  local pid
  pid=$(pm2 pid "$APP" 2>/dev/null | tr -d '\r' || true)
  [ -z "$pid" ] || [ "$pid" = "0" ] && return 1
  [ -r "/proc/$pid/environ" ] || return 1
  tr '\0' '\n' < "/proc/$pid/environ" \
    | grep -E '^(AUTH_TOKEN|GITHUB_TOKEN|LLM_[A-Z_]*|PORT|REFRESH_HOURS|LEDGER_PATH)=' \
    || true
}

show_config() {
  bold "--- current configuration (masked) ---"
  local live=""
  if live=$(snapshot_live_env); then :; else live=""; fi
  local src="live process"
  [ -f "$ENVFILE" ] && { src="$ENVFILE"; live=$(grep -E '^[A-Z_]+=' "$ENVFILE" || true); }
  printf '  source: %s\n' "$src"
  if [ -z "$live" ]; then red "  (nothing found - app not running and no env file)"; return; fi
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local k="${line%%=*}" v="${line#*=}"
    case "$k" in
      AUTH_TOKEN|GITHUB_TOKEN|LLM_API_KEY) printf '  %-16s = %s\n' "$k" "$(mask "$v")" ;;
      *)                                 printf '  %-16s = %s\n' "$k" "$v" ;;
    esac
  done <<< "$live"
}

verify() {
  bold "--- verification ---"
  local tok pid ok=1
  tok=$(cat "$TOKENFILE" 2>/dev/null | tr -d '\r\n' || true)
  if [ -z "$tok" ]; then red "  AUTH_TOKEN file missing/empty: $TOKENFILE"; ok=0
  else green "  AUTH_TOKEN file present ($(printf '%s' "$tok" | wc -c) chars)"; fi

  pid=$(pm2 pid "$APP" 2>/dev/null | tr -d '\r' || true)
  if [ -z "$pid" ] || [ "$pid" = "0" ]; then red "  $APP is NOT running"; return 1; fi
  green "  $APP running (pid $pid, $(pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s).find(x=>x.name==="msql-upstream-watch");console.log(p?"restarts="+p.pm2_env.restart_time:"?")}catch(e){console.log("?")}})'))"

  local port
  port=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -E '^PORT=' | cut -d= -f2- | tr -d '\r' || true)
  [ -z "$port" ] && port="$PORT_DEFAULT"

  local c1 c2
  c1=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://127.0.0.1:$port/api/state" || echo 000)
  c2=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -H "Authorization: Bearer $tok" "http://127.0.0.1:$port/api/state" || echo 000)
  # Both must pass. Checking only the 200 is how you end up thinking auth works
  # when the service is wide open.
  if [ "$c1" = "401" ]; then green "  auth no-token  -> $c1 (correct: rejected)"
  else red "  auth no-token  -> $c1 (expected 401 - service may be UNAUTHENTICATED)"; ok=0; fi
  if [ "$c2" = "200" ]; then green "  auth with-token-> $c2 (correct: accepted)"
  else red "  auth with-token-> $c2 (expected 200 - token mismatch)"; ok=0; fi

  local gt
  gt=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -E '^GITHUB_TOKEN=' | cut -d= -f2- | tr -d '\r' || true)
  if [ -n "$gt" ]; then green "  GITHUB_TOKEN present in process env"
  else amber "  GITHUB_TOKEN ABSENT - anonymous 60/hour limit applies"; ok=0; fi

  # Only send the Authorization header when a token actually exists - an empty
  # "Bearer " makes GitHub answer 401 with a body we cannot parse, which would
  # read as "no rate limit info" instead of "anonymous limit".
  if [ -n "$gt" ]; then
    RLARGS=(-H "Authorization: Bearer $gt")
  else
    RLARGS=()
  fi
  printf '  github core: '
  curl -s --max-time 12 "${RLARGS[@]}" https://api.github.com/rate_limit \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const c=JSON.parse(s).resources.core;console.log("limit="+c.limit+"  remaining="+c.remaining+(c.remaining<c.limit*0.2?"   <-- LOW":"   ok"))}catch(e){console.log("could not parse")}})'

  local lk lm
  lk=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -E '^LLM_API_KEY=' | cut -d= -f2- | tr -d '\r' || true)
  lm=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -E '^LLM_MODEL=' | cut -d= -f2- | tr -d '\r' || true)
  if [ -n "$lk" ]; then green "  LLM_API_KEY present  model=${lm:-<unset>}"; else amber "  LLM_API_KEY absent - running rules-only (no error will be shown)"; fi

  if [ -f "$ENVFILE" ]; then green "  persisted env file: $ENVFILE ($(stat -c '%a' "$ENVFILE"))"
  else red "  no persisted env file - config will be LOST on reboot"; ok=0; fi

  if [ "$ok" = "1" ]; then printf '\n'; green "All checks passed."
  else printf '\n'; red "Some checks FAILED (see above)."; fi
  return $((1-ok))
}

case "${1:-}" in
  --show)
    show_config; exit 0 ;;
  --verify)
    verify; exit $? ;;
  --reset)
    bold "Removing GITHUB_TOKEN from $ENVFILE (keeping everything else)"
    if [ -f "$ENVFILE" ]; then
      cp -a "$ENVFILE" "$ENVFILE.bak.$(date +%Y%m%d%H%M%S)"
      grep -v '^GITHUB_TOKEN=' "$ENVFILE" > "$ENVFILE.tmp" && mv "$ENVFILE.tmp" "$ENVFILE"
      chmod 600 "$ENVFILE"
    fi
    set -a; [ -f "$ENVFILE" ] && . "$ENVFILE"; set +a
    pm2 restart "$APP" --update-env >/dev/null 2>&1 || true
    pm2 save >/dev/null 2>&1 || true
    green "Done. GITHUB_TOKEN removed; expect 60/hour limit again."
    exit 0 ;;
  "")
    die "no arguments. Try:  ./setup-watch.sh <github_token>" ;;
esac

# ---------------------------------------------------------------- apply mode
GITHUB_TOKEN_NEW="$1"; shift || true
DO_REFRESH=0
for a in "$@"; do [ "$a" = "--refresh" ] && DO_REFRESH=1; done

bold "=== preflight ==="
[ "$(id -u)" = "0" ] || die "must run as root (pm2 is a root process here)"
command -v node >/dev/null || die "node not found"
command -v pm2  >/dev/null || die "pm2 not found"
green "  node $(node -v) / pm2 $(pm2 -v)"

# 1. validate token against GitHub BEFORE touching anything
bold "=== validating the GitHub token ==="
if [ "${GITHUB_TOKEN_NEW:0:4}" = "ghp_" ] || [ "${GITHUB_TOKEN_NEW:0:4}" = "ghs_" ]; then
  green "  looks like a classic PAT (ghp_/ghs_). Fine-grained (github_pat_) is better - it can be scoped to read-only public repos."
fi
RL=$(curl -s --max-time 15 https://api.github.com/rate_limit -H "Authorization: Bearer $GITHUB_TOKEN_NEW" || echo '{}')
LIMIT=$(printf '%s' "$RL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).resources.core.limit||0)}catch(e){console.log(0)}})')
if [ "$LIMIT" -lt 100 ]; then
  die "token does not appear to work - GitHub reports core.limit=$LIMIT (anonymous is 60, an authenticated token is 5000).
     Check:  - token copied in full, no trailing newline
             - token not expired / not revoked
             - fine-grained token has 'Public repositories: read' OR no permission restrictions at all"
fi
green "  token valid - core.limit=$LIMIT requests/hour"

# 2. build the new env file from the live process + the new token
bold "=== building persistent config ==="
if [ -f "$ENVFILE" ]; then
  cp -a "$ENVFILE" "$ENVFILE.bak.$(date +%Y%m%d%H%M%S)"
  amber "  backed up existing $ENVFILE"
fi
SNAP=$(snapshot_live_env || true)
if [ -n "$SNAP" ]; then
  amber "  snapshotting $(printf '%s\n' "$SNAP" | grep -c '=') env var(s) from the live process (preserves your LLM_* settings)"
else
  amber "  no live process env found - falling back to defaults"
fi
{
  printf '%s\n' "$SNAP" | grep -v '^GITHUB_TOKEN=' || true
  echo "GITHUB_TOKEN=$GITHUB_TOKEN_NEW"
  echo "REFRESH_HOURS=${REFRESH_HOURS:-24}"
  echo "PORT=${PORT:-$PORT_DEFAULT}"
} | grep -E '^[A-Z_]+=' | sort -u > "$ENVFILE.tmp"
mv "$ENVFILE.tmp" "$ENVFILE"
chmod 600 "$ENVFILE"
green "  wrote $ENVFILE (mode 600, $(wc -l < "$ENVFILE") lines)"
show_config

# 3. restart with the persisted env
bold "=== restarting $APP ==="
set -a
# shellcheck disable=SC1090
. "$ENVFILE"
set +a
pm2 restart "$APP" --update-env
pm2 save
green "  restarted and saved (will survive reboot)"

# 4. give node a moment, then verify hard
sleep 3
bold ""
if ! verify; then
  red ""
  red "Verification failed. Rollback:"
  red "  ls -1t $ENVFILE.bak.* | head -1"
  red "  <inspect it, then>  set -a; . <that file>; set +a; pm2 restart $APP --update-env"
  exit 1
fi

if [ "$DO_REFRESH" = "1" ]; then
  bold ""
  bold "=== triggering a fetch (this calls the GitHub API 9-20 times) ==="
  TOK=$(cat "$TOKENFILE" | tr -d '\r\n')
  curl -s -X POST -H "Authorization: Bearer $TOK" --max-time 180 \
    "http://127.0.0.1:${PORT:-$PORT_DEFAULT}/api/refresh" \
    | head -c 400; echo
  amber "fetch dispatched; the page refreshes itself once it completes"
fi

green ""
green "Setup complete. Open https://watch.logic-yjb.top"
