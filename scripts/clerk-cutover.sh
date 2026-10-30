#!/usr/bin/env bash
# Clerk production cutover, step 5 of docs/security/clerk-production-cutover.md, in one command.
#   scripts/clerk-cutover.sh user_<your production id>
# It runs the runbook's pre-check (stops if any development-instance tenant exists), checks the production
# instance answers, then edits wrangler.toml (issuer, founder sub, authorized parties) and web/.env (the
# pk_live key, derived from the Frontend API host, which is public). It does NOT commit or deploy: the
# normal ship loop does (branch → npm test → PR → merge → npm run deploy). Rollback: runbook §9.
set -euo pipefail
cd "$(dirname "$0")/.."

SUB="${1:-}"
FAPI_HOST="${CLERK_FAPI_HOST:-clerk.quillo.au}"
[[ "$SUB" =~ ^user_[A-Za-z0-9]{10,}$ ]] || { echo "usage: $0 user_<production Clerk user id>  (Clerk dashboard → Production → Users)"; exit 2; }

echo "1/4 pre-check (remote D1, read-only)…"
OUT=$(npx wrangler d1 execute tax-agent-db --remote --json --command \
  "SELECT SUM(user_id LIKE 'user_%') AS clerk_subs FROM profiles" 2>/dev/null)
SUBS=$(printf '%s' "$OUT" | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['results'][0]['clerk_subs'] or 0)")
[ "$SUBS" = "0" ] || { echo "STOP: $SUBS tenant(s) are keyed by a development-instance id. They need a planned id migration first (runbook §0)."; exit 1; }

echo "2/4 production instance at https://${FAPI_HOST}…"
[ "$(curl -s -o /dev/null -w '%{http_code}' "https://$FAPI_HOST/.well-known/jwks.json")" = "200" ] || { echo "STOP: https://$FAPI_HOST/.well-known/jwks.json isn't answering"; exit 1; }
ENVTYPE=$(curl -s "https://$FAPI_HOST/v1/environment" | python3 -c "import json,sys;print(json.load(sys.stdin)['display_config']['instance_environment_type'])")
[ "$ENVTYPE" = "production" ] || { echo "STOP: $FAPI_HOST is a '$ENVTYPE' instance, not production"; exit 1; }

echo "3/4 wrangler.toml…"
python3 - "$SUB" "$FAPI_HOST" <<'PY'
import re, sys
sub, host = sys.argv[1], sys.argv[2]
p = "wrangler.toml"; s = open(p).read()
s = re.sub(r'^CLERK_ISSUER = ".*"$', f'CLERK_ISSUER = "https://{host}"', s, count=1, flags=re.M)
s = re.sub(r'^CLERK_FOUNDER_SUB = ".*"$', f'CLERK_FOUNDER_SUB = "{sub}"', s, count=1, flags=re.M)
if re.search(r'^CLERK_AUTHORIZED_PARTIES = ', s, flags=re.M):
    s = re.sub(r'^CLERK_AUTHORIZED_PARTIES = ".*"$', 'CLERK_AUTHORIZED_PARTIES = "https://app.quillo.au"', s, count=1, flags=re.M)
else:
    s = re.sub(r'^(CLERK_FOUNDER_SUB = ".*")$', r'\1\n# Production: only tokens minted by the real app origin (runbook §5).\nCLERK_AUTHORIZED_PARTIES = "https://app.quillo.au"', s, count=1, flags=re.M)
open(p, "w").write(s)
PY
grep -E '^CLERK_(ISSUER|FOUNDER_SUB|AUTHORIZED_PARTIES) ' wrangler.toml

echo "4/4 web/.env (old file kept as web/.env.dev-backup)…"
PK="pk_live_$(printf '%s$' "$FAPI_HOST" | base64 | tr -d '\n')"
[ -f web/.env ] && cp web/.env web/.env.dev-backup
touch web/.env
python3 - "$PK" <<'PY'
import re, sys
p = "web/.env"; s = open(p).read()
line = f"VITE_CLERK_PUBLISHABLE_KEY={sys.argv[1]}"
s = re.sub(r"^VITE_CLERK_PUBLISHABLE_KEY=.*$", line, s, count=1, flags=re.M) if re.search(r"^VITE_CLERK_PUBLISHABLE_KEY=", s, flags=re.M) else s.rstrip("\n") + "\n" + line + "\n"
open(p, "w").write(s)
PY
echo "   publishable key set (pk_live_…, ${#PK} chars)"

cat <<NEXT

Done locally. Next (the normal ship loop):
  git checkout -b security/clerk-production && npm test
  commit wrangler.toml, open the PR (old dev values in the body for rollback), merge
  npm run deploy   # bakes the pk_live key into the SPA
  then sign in at https://app.quillo.au with the SAME identity as $SUB, and run the runbook §8 test plan.
NEXT
