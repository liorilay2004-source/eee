#!/usr/bin/env bash
# Post-deploy smoke test for the eee API. Read-only: GETs of /api/health, /api/deals, /api/calendar, /api/explore
# and ONE POST /api/search (well inside the per-client rate limit). Needs only bash, curl and python3.
#
#   scripts/smoke.sh [BASE_URL]        default: https://eee-api.liorilay2004.workers.dev
#
# Prints a pass/fail table (Hebrew / English) and exits 0 when every check passed, 1 otherwise.
# A 429 (rate limited) counts as a failure: the endpoint was not actually checked.
#
# Private-use lock (worker/src/access.ts): when the API is locked, give the key in the environment variable EEE_ACCESS_KEY.
# It is sent only as "Authorization: Bearer <key>", read by curl from a private temporary file (never on a command line,
# so never in the process list), and never printed. To keep it out of the shell history, and out of the shell's
# environment afterwards (the parentheses run it all in a subshell), paste the key at the silent prompt and press Enter:
#   ( read -rs EEE_ACCESS_KEY && export EEE_ACCESS_KEY && bash scripts/smoke.sh )
set -uo pipefail

BASE="${1:-https://eee-api.liorilay2004.workers.dev}"
BASE="${BASE%/}"
umask 077
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for tool in curl python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "חסר $tool / missing $tool" >&2; exit 2; }
done

AUTH_FILE=""
if [[ -n "${EEE_ACCESS_KEY:-}" ]]; then
  # Surrounding whitespace (a paste) is dropped; what is left must be 20-256 visible ASCII characters, the Worker's rule (a
  # key outside it can never be right, and would only use up one of the failed attempts the Worker allows this address).
  # The key reaches python3 on stdin and the file through the printf builtin: never as a process argument.
  KEY_TRIMMED="$(printf '%s' "$EEE_ACCESS_KEY" | python3 -c 'import sys; print(sys.stdin.read().strip(), end="")')"
  if ! printf '%s' "$KEY_TRIMMED" | python3 -c 'import re, sys; sys.exit(0 if re.fullmatch(r"[\x21-\x7e]{20,256}", sys.stdin.read()) else 1)'; then
    echo "EEE_ACCESS_KEY לא תקין: 20–256 תווים גלויים באנגלית, בלי רווחים / EEE_ACCESS_KEY is not a valid key" >&2
    exit 2
  fi
  AUTH_FILE="$TMP/auth.header"
  printf 'Authorization: Bearer %s\n' "$KEY_TRIMMED" >"$AUTH_FILE"
  unset KEY_TRIMMED
fi

# Next calendar month (UTC) and a 10-day window inside it for the search.
read -r NEXT_MONTH WIN_START WIN_END < <(python3 -c '
import datetime as d
t = d.datetime.now(d.timezone.utc).date()
y, m = (t.year + 1, 1) if t.month == 12 else (t.year, t.month + 1)
print(f"{y:04d}-{m:02d}", f"{y:04d}-{m:02d}-10", f"{y:04d}-{m:02d}-20")')

ROWS=()
FAILED=0
# What the access lock answered, for the hints after the table: 401 (no or wrong key), 503 misconfigured, 429 too many attempts.
SAW_401=0
SAW_MISCONFIGURED=0
SAW_TOO_MANY=0

# check NAME_HE NAME_EN METHOD PATH [BODY]; the JSON assertion for NAME_EN is in validate() below.
check() {
  local he="$1" en="$2" method="$3" path="$4" body="${5:-}"
  local out="$TMP/$en.json" code time detail
  local args=(-sS -o "$out" -w "%{http_code} %{time_total}" --max-time 60 -H "Accept: application/json" -H "User-Agent: eee-smoke/1")
  if [[ -n "$AUTH_FILE" ]]; then args+=(-H "@$AUTH_FILE"); fi
  if [[ "$method" == POST ]]; then args+=(-X POST -H "Content-Type: application/json" --data "$body"); fi
  if ! read -r code time < <(curl "${args[@]}" "$BASE$path" 2>"$TMP/$en.err"; echo); then code=000; time=0; fi
  [[ -z "${code:-}" ]] && code=000
  if [[ "$code" == 000 ]]; then
    detail="network error: $(head -c 120 "$TMP/$en.err" | tr '\n' ' ')"
    ROWS+=("FAIL|$he|$en|$code|${time:-0}|$detail"); FAILED=1; return
  fi
  if [[ "$code" == 401 ]]; then SAW_401=1; fi
  if [[ "$code" == 503 ]] && grep -q '"access_misconfigured"' "$out" 2>/dev/null; then SAW_MISCONFIGURED=1; fi
  if [[ "$code" == 429 ]] && grep -q '"too_many_attempts"' "$out" 2>/dev/null; then SAW_TOO_MANY=1; fi
  if detail="$(python3 - "$en" "$code" "$out" <<'PY'
import json, sys
name, code, path = sys.argv[1], int(sys.argv[2]), sys.argv[3]
raw = open(path, "rb").read()
try:
    j = json.loads(raw or b"null")
except ValueError:
    print(f"not JSON: {raw[:80]!r}"); sys.exit(1)
def fail(msg): print(msg); sys.exit(1)
if code != 200:
    err = j.get("error", {}) if isinstance(j, dict) else {}
    fail(f"HTTP {code} {err.get('code', '') if isinstance(err, dict) else ''}".strip())
if not isinstance(j, dict): fail("not a JSON object")
if name == "health":
    if j.get("status") != "ok" or j.get("db") != "ok": fail(f"status={j.get('status')} db={j.get('db')}")
    lock = j.get("lockStatus")
    lock_info = f"lock={lock}" if lock in ("on", "off", "misconfigured") else "lock=n/a"
    if "build" not in j:
        print(f"ok (deploy predates build/migration fields) {lock_info}"); sys.exit(0)
    b = j.get("build") or {}
    info = f"build={b.get('sha')} @ {b.get('time') or '-'} migration={json.dumps(j.get('migration'))} pending={json.dumps(j.get('migrationsPending'))} {lock_info}"
    if j.get("migrationsPending") is True: fail(f"migrations pending! {info}")
    print(info)
elif name == "deals":
    if not isinstance(j.get("routes"), list): fail("no routes[]")
    print(f"routes={len(j['routes'])} asOf={j.get('asOf')}")
elif name == "calendar":
    if not isinstance(j.get("days"), list): fail("no days[]")
    print(f"days={len(j['days'])}")
elif name == "explore":
    if not isinstance(j.get("results"), list): fail("no results[]")
    print(f"results={len(j['results'])}")
elif name == "search":
    if not isinstance(j.get("cards"), list): fail("no cards[]")
    m = j.get("meta") or {}
    print(f"cards={len(j['cards'])} fromCache={m.get('fromCache')}")
PY
)"; then
    ROWS+=("PASS|$he|$en|$code|$time|$detail")
  else
    ROWS+=("FAIL|$he|$en|$code|$time|$detail"); FAILED=1
  fi
}

echo "בדיקת עשן / smoke test: $BASE  (חודש הבא / next month: $NEXT_MONTH)"
echo
check "בריאות"        health   GET  "/api/health"
check "דילים"         deals    GET  "/api/deals"
check "לוח מחירים"    calendar GET  "/api/calendar?origin=TLV&destination=ATH&month=$NEXT_MONTH"
check "גילוי יעדים"   explore  GET  "/api/explore?origin=TLV&month=$NEXT_MONTH"
check "חיפוש"         search   POST "/api/search" \
  "{\"origin\":\"TLV\",\"destination\":\"ATH\",\"windowStart\":\"$WIN_START\",\"windowEnd\":\"$WIN_END\",\"stayMin\":3,\"stayMax\":5}"

# Printed by python3: printf pads by bytes, which misaligns the Hebrew column.
printf '%s\n' "${ROWS[@]}" | python3 -c '
import sys
rows = [["RESULT", "בדיקה", "CHECK", "HTTP", "SEC", "DETAIL"]] + [l.rstrip("\n").split("|", 5) for l in sys.stdin if l.strip()]
w = [max(len(r[i]) for r in rows) for i in range(5)]
for r in rows: print("  ".join(c.ljust(w[i]) for i, c in enumerate(r[:5])) + "  " + r[5])'
echo

# The private-use lock, as /api/health reports it (public: it answers with or without the key, and never contains it).
LOCK_STATUS="$(python3 - "$TMP/health.json" <<'PY' 2>/dev/null
import json, sys
try:
    j = json.load(open(sys.argv[1], "rb"))
except Exception:
    print("unknown"); sys.exit(0)
s = j.get("lockStatus") if isinstance(j, dict) else None
print(s if s in ("on", "off", "misconfigured") else "n/a")
PY
)"
case "${LOCK_STATUS:-unknown}" in
  on) echo "מצב הנעילה / lock status: on — האתר נעול לשימוש אישי; ה-API עונה רק עם המפתח" ;;
  off) echo "מצב הנעילה / lock status: off — ה-API פתוח לכולם (הסוד ACCESS_KEY לא מוגדר)" ;;
  misconfigured) echo "מצב הנעילה / lock status: misconfigured — ACCESS_KEY קצר מ-20 תווים או לא תקין, וה-API סגור לגמרי עד שיתוקן" ;;
  n/a) echo "מצב הנעילה / lock status: n/a — הגרסה שבאוויר קודמת לנעילה" ;;
  *) echo "מצב הנעילה / lock status: unknown — /api/health לא ענה" ;;
esac
if [[ $SAW_401 -eq 1 ]]; then
  echo "האתר נעול: הריצו EEE_ACCESS_KEY=... bash scripts/smoke.sh"
  # The line above is the documented hint; typed literally with the key, it would leave the key in the shell history. So:
  echo "בלי שהמפתח יישמר בהיסטוריה: ( read -rs EEE_ACCESS_KEY && export EEE_ACCESS_KEY && bash scripts/smoke.sh ) — המסוף לא יציג כלום: מדביקים את המפתח ולוחצים Enter"
  if [[ -n "$AUTH_FILE" ]]; then echo "המפתח שב-EEE_ACCESS_KEY נדחה (401): בדקו שזה בדיוק הערך שהוגדר ב-ACCESS_KEY / the key was refused"; fi
fi
if [[ $SAW_MISCONFIGURED -eq 1 ]]; then
  echo "ACCESS_KEY מוגדר אבל לא תקין (למשל קצר מ-20 תווים): הגדירו מפתח חדש עם npx wrangler secret put ACCESS_KEY"
fi
if [[ $SAW_TOO_MANY -eq 1 ]]; then
  echo "יותר מדי ניסיונות עם מפתח שגוי מהכתובת הזו: חכו כמה דקות ונסו שוב (הזמן המדויק בכותרת Retry-After)"
fi
echo
if [[ $FAILED -eq 0 ]]; then
  echo "הכול תקין / all checks passed"
else
  echo "יש כשלים / some checks FAILED"
fi
exit "$FAILED"
