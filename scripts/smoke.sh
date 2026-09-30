#!/usr/bin/env bash
# Post-deploy smoke test for the eee API. Read-only: GETs of /api/health, /api/deals, /api/calendar, /api/explore
# and ONE POST /api/search (well inside the per-client rate limit). Needs only bash, curl and python3.
#
#   scripts/smoke.sh [BASE_URL]        default: https://eee-api.liorilay2004.workers.dev
#
# Prints a pass/fail table (Hebrew / English) and exits 0 when every check passed, 1 otherwise.
# A 429 (rate limited) counts as a failure: the endpoint was not actually checked.
set -uo pipefail

BASE="${1:-https://eee-api.liorilay2004.workers.dev}"
BASE="${BASE%/}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for tool in curl python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "חסר $tool / missing $tool" >&2; exit 2; }
done

# Next calendar month (UTC) and a 10-day window inside it for the search.
read -r NEXT_MONTH WIN_START WIN_END < <(python3 -c '
import datetime as d
t = d.datetime.now(d.timezone.utc).date()
y, m = (t.year + 1, 1) if t.month == 12 else (t.year, t.month + 1)
print(f"{y:04d}-{m:02d}", f"{y:04d}-{m:02d}-10", f"{y:04d}-{m:02d}-20")')

ROWS=()
FAILED=0

# check NAME_HE NAME_EN METHOD PATH [BODY]; the JSON assertion for NAME_EN is in validate() below.
check() {
  local he="$1" en="$2" method="$3" path="$4" body="${5:-}"
  local out="$TMP/$en.json" code time detail
  local args=(-sS -o "$out" -w "%{http_code} %{time_total}" --max-time 60 -H "Accept: application/json" -H "User-Agent: eee-smoke/1")
  if [[ "$method" == POST ]]; then args+=(-X POST -H "Content-Type: application/json" --data "$body"); fi
  if ! read -r code time < <(curl "${args[@]}" "$BASE$path" 2>"$TMP/$en.err"; echo); then code=000; time=0; fi
  [[ -z "${code:-}" ]] && code=000
  if [[ "$code" == 000 ]]; then
    detail="network error: $(head -c 120 "$TMP/$en.err" | tr '\n' ' ')"
    ROWS+=("FAIL|$he|$en|$code|${time:-0}|$detail"); FAILED=1; return
  fi
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
    if "build" not in j:
        print("ok (deploy predates build/migration fields)"); sys.exit(0)
    b = j.get("build") or {}
    info = f"build={b.get('sha')} @ {b.get('time') or '-'} migration={json.dumps(j.get('migration'))} pending={json.dumps(j.get('migrationsPending'))}"
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
if [[ $FAILED -eq 0 ]]; then
  echo "הכול תקין / all checks passed"
else
  echo "יש כשלים / some checks FAILED"
fi
exit "$FAILED"
