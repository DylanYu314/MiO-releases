#!/usr/bin/env bash
#
# Answer the three questions #492's private-favourites slice is blocked on.
#
#   ./scripts/bili-fav-check.sh
#
# ## Why this is a script and not three curl commands
#
# It was three curl commands, in `docs/bilibili.md`. They were run three times
# on 2026-08-14 without their `export` line, and every run answered
#
#   {"code":0,"message":"OK","ttl":1,"data":null}
#
# which looks like a successful read of an empty folder and is nothing of the
# kind: an unset `$MEDIA_ID` and an unset `$SESSDATA` ask for no folder with no
# credential, and this API answers `code: 0` to that. **On this API `code: 0`
# means "I parsed your request", not "here is your answer"** — the qrcode/poll
# endpoint does the same thing for a login that has not happened.
#
# So the shell prompts for what it needs and refuses to run without it. There is
# no variable to forget.
#
# ## The credential never touches the disk
#
# `read -rs` keeps SESSDATA out of the shell history and out of any file, and
# nothing here echoes it. That matters more than usual: **SESSDATA *is* the
# Bilibili account** — no scopes, no per-app revocation — which is the whole
# reason §6.1 needed a decision before the feature could be designed.
#
# ⚠️ Run this on the laptop, never on the droplet. "Device only, never the
# droplet" is one of the slice's non-negotiables, and the droplet would answer
# the same anyway: §2.1 measured the ceiling on *search*, and these are `fav`
# endpoints, so the address is not the variable under test.

set -euo pipefail

UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
API='https://api.bilibili.com/x/v3/fav'

# A folder that is public and real, so the pipeline can be proved before any
# answer about a private one is believed. Measured 2026-08-14: `0 默认收藏夹`.
KNOWN_PUBLIC_MEDIA_ID='486002245'

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

fetch() {
  # $1 url, $2 cookie header (may be empty)
  if [ -n "${2:-}" ]; then
    curl -sS -m 30 "$1" -H "User-Agent: $UA" -H "Referer: https://www.bilibili.com/" -b "$2"
  else
    curl -sS -m 30 "$1" -H "User-Agent: $UA" -H "Referer: https://www.bilibili.com/"
  fi
}

# ---------------------------------------------------------------------------
# 0. Prove the pipeline before trusting any negative result.
# ---------------------------------------------------------------------------
say "0. Sanity check — a public folder, no cookie at all"
fetch "$API/resource/list?media_id=$KNOWN_PUBLIC_MEDIA_ID&pn=1&ps=3&platform=web" '' |
  python3 -c '
import sys, json
d = json.load(sys.stdin)
data = d.get("data")
title = ((data or {}).get("info") or {}).get("title")
rows = len((data or {}).get("medias") or [])
print("   code=%s  title=%s  rows=%d" % (d.get("code"), title, rows))
if data is None or not rows:
    print("   ✗ The request pipeline is broken — curl, network or python.")
    print("     Nothing below would mean anything. Stop here.")
    sys.exit(1)
print("   ✓ Requests work. A failure below is about the credential, not the command.")
'

# ---------------------------------------------------------------------------
# 1. The credential. Prompted, never a variable, never echoed.
# ---------------------------------------------------------------------------
say "1. Your Bilibili cookie"
cat <<'HOW'
   Log in to bilibili.com in a browser, then:
     DevTools (F12) → Application → Cookies → https://www.bilibili.com
   Copy the VALUE of SESSDATA, bili_jct and DedeUserID.

   ⚠️ SESSDATA is the whole account. Nothing here stores or prints it.
HOW

read -rsp '   SESSDATA:   ' SESSDATA; echo
read -rp  '   DedeUserID: ' DEDEUSERID
read -rsp '   bili_jct:   ' BILI_JCT; echo

[ -n "$SESSDATA" ] || { echo "   ✗ SESSDATA was empty. Nothing to measure." >&2; exit 1; }
[ -n "$DEDEUSERID" ] || { echo "   ✗ DedeUserID was empty." >&2; exit 1; }

# ---------------------------------------------------------------------------
# 2. Which folders exist, and which of them are private.
# ---------------------------------------------------------------------------
say "2. Your favourite folders"
FOLDERS="$(fetch "$API/folder/created/list-all?up_mid=$DEDEUSERID" "SESSDATA=$SESSDATA")"

echo "$FOLDERS" | python3 -c '
import sys, json
d = json.load(sys.stdin)
data = d.get("data")
if data is None:
    print("   code=%s message=%s  data=null" % (d.get("code"), d.get("message")))
    print("   ✗ The cookie was rejected or the request was malformed.")
    print("     A -101 here means SESSDATA is not valid (expired, or mis-copied).")
    sys.exit(1)
folders = data.get("list") or []
if not folders:
    print("   ✗ No folders returned.")
    sys.exit(1)
private = 0
for f in folders:
    kind = "PRIVATE" if f["attr"] & 1 else "public "
    if f["attr"] & 1:
        private += 1
    print("   %s  media_id=%s  count=%-5s %s" % (kind, f["id"], f["media_count"], f["title"]))
print()
if private:
    print("   %d private folder(s). Use one of their media_ids next." % private)
else:
    print("   ⚠️ No PRIVATE folder here. Make one private in the Bilibili app and")
    print("      re-run, or question 1 cannot be answered.")
'

# ---------------------------------------------------------------------------
# 3. THE PREMISE — does a private folder read back with SESSDATA alone?
# ---------------------------------------------------------------------------
say "3. The premise — read a PRIVATE folder"
read -rp '   media_id of a PRIVATE folder from above: ' MEDIA_ID
[ -n "$MEDIA_ID" ] || { echo "   ✗ No media_id given." >&2; exit 1; }

LIST_URL="$API/resource/list?media_id=$MEDIA_ID&pn=1&ps=20&platform=web"

say "   (1) SESSDATA only"
ONLY="$(fetch "$LIST_URL" "SESSDATA=$SESSDATA")"
echo "$ONLY" | python3 -c '
import sys, json
d = json.load(sys.stdin); data = d.get("data")
rows = len((data or {}).get("medias") or [])
print("   code=%s  message=%s  data_null=%s  rows=%d" % (d.get("code"), d.get("message"), data is None, rows))
'

say "   (2) SESSDATA + bili_jct + DedeUserID"
ALL="$(fetch "$LIST_URL" "SESSDATA=$SESSDATA; bili_jct=$BILI_JCT; DedeUserID=$DEDEUSERID")"
echo "$ALL" | python3 -c '
import sys, json
d = json.load(sys.stdin); data = d.get("data")
rows = len((data or {}).get("medias") or [])
print("   code=%s  message=%s  data_null=%s  rows=%d" % (d.get("code"), d.get("message"), data is None, rows))
'

# ---------------------------------------------------------------------------
# 4. The verdict, spelled out, so the answer is not a judgement call.
# ---------------------------------------------------------------------------
say "VERDICT — paste this, and nothing else, into the issue"
python3 - "$ONLY" "$ALL" <<'PY'
import sys, json

only, allc = (json.loads(a) for a in sys.argv[1:3])

def read(d):
    data = d.get("data")
    return d.get("code"), data, len((data or {}).get("medias") or [])

c1, d1, n1 = read(only)
c2, d2, n2 = read(allc)

print("  SESSDATA only        : code=%s data_null=%s rows=%d" % (c1, d1 is None, n1))
print("  all three cookies    : code=%s data_null=%s rows=%d" % (c2, d2 is None, n2))
print()

if d1 is None and c1 == 0:
    print("  ✗ NOT AN ANSWER — code 0 with data null means the request asked for")
    print("    nothing. The media_id was probably wrong. Re-run.")
elif c1 == 0 and n1 > 0:
    print("  ✅ THE PREMISE HOLDS — a private folder reads back with SESSDATA alone.")
    print("     Build the QR login.")
    if c2 == c1 and n2 == n1:
        print("  ✅ bili_jct is NOT needed for reads — discard it, so a leaked store")
        print("     cannot post as the user.")
    else:
        print("  ⚠️ bili_jct changed the answer — it has to be stored. Say so in the")
        print("     slice's threat notes.")
elif c1 == -403:
    print("  ✗ -403 — SESSDATA alone is not enough. STOP: re-plan §6.1 before")
    print("    writing any login code.")
elif c1 == -101:
    print("  ✗ -101 — not logged in. The SESSDATA is expired or was mis-copied.")
    print("    This says nothing about the feature; get a fresh cookie and re-run.")
else:
    print("  ? Unhandled code %s. Report it as-is." % c1)
PY

echo
echo "  (4) is a calendar item: note today's date, and re-run this in a week and"
echo "      a month to see how long a SESSDATA lasts. It must not block the build."
echo
