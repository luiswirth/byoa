#!/usr/bin/env bash
# The spec's examples, run with curl against the relay at $1.
set -euo pipefail

relay=${1:-http://localhost:8790}
work=$(mktemp -d)
failed=0

check() {
  if [ "$2" = "$3" ]; then
    echo "ok    $1"
  else
    echo "FAIL  $1: got '$2', expected '$3'"
    failed=1
  fi
}

status() {
  curl -s -o /dev/null -w '%{http_code}' "$@"
}

# Receives at $1 until the presence shows $2 receiving, for at most 50 tries:
# a receive sent in the background is waiting only once the relay has it.
until_receiving() {
  for _ in $(seq 50); do
    [ "$(curl -s "$1" | tail -1 | jq ".presence[\"$2\"].receiving")" = true ] && return
    sleep 0.1
  done
}

for _ in $(seq 60); do
  curl -sf -o /dev/null "$relay/transport.md" && break
  sleep 0.5
done

check "the spec at /transport.md" "$(curl -s "$relay/transport.md" | head -1)" "# The polylogue transport"
check "speech at /speech.md" "$(curl -s "$relay/speech.md" | head -1)" "# Speech"

link=$(curl -s -X POST "$relay/v1/s")
joined=$(curl -s -X POST "$link/join?as=luis")
check "join" "$(jq -c '[.n, .name, .read]' <<<"$joined")" '[1,"luis",0]'
luis=$(jq -r .link <<<"$joined")
check "an own link" "$(grep -cE "^$link/[A-Za-z0-9_-]{22}\$" <<<"$luis")" 1
check "a name taken" "$(status -X POST "$link/join?as=luis")" 409
check "join again while in" "$(curl -s -X POST "$luis/join" | jq -c '[.n, .name]')" '[1,"luis"]'
check "send unjoined" "$(status --data-binary 'Hi.' "$link")" 403
check "send with no participant's link" "$(status --data-binary 'Hi.' "$link/AAAAAAAAAAAAAAAAAAAAAA")" 403
joined=$(curl -s -X POST "$link/join?as=luis/claude")
check "join another" "$(jq .n <<<"$joined")" 2
claude=$(jq -r .link <<<"$joined")

check "send text" "$(curl -s --data-binary 'Hello.' "$luis")" '{"n":3}'
printf '**Notes**\n' >"$work/notes.md"
check "send markdown" "$(curl -s -H 'Content-Type: text/markdown' --data-binary @"$work/notes.md" "$luis")" '{"n":4}'
head -c 70000 /dev/urandom >"$work/plot.png"
check "send a file" "$(curl -s -H 'Content-Type: image/png' --data-binary @"$work/plot.png" "$luis?filename=plot.png")" '{"n":5}'

received=$(curl -s "$claude?after=0&wait=0")
check "receive others' entries" "$(head -n -1 <<<"$received" | jq -r .n | xargs)" "1 3 4 5"
check "inline text" "$(jq -r 'select(.n == 3) | .text' <<<"$received")" "Hello."
check "default type" "$(jq -r 'select(.n == 3) | .type' <<<"$received")" "text/plain; charset=utf-8"
check "no inline binary" "$(jq -r 'select(.n == 5) | [.text, .filename, .size] | join(" ")' <<<"$received")" " plot.png 70000"
check "presence last" "$(tail -1 <<<"$received" | jq -c '.presence | keys')" '["luis","luis/claude"]'

curl -s -o "$work/fetched.png" "$claude/5"
check "fetch a payload" "$(cmp -s "$work/plot.png" "$work/fetched.png" && echo same)" same
check "fetch a type" "$(curl -s -o /dev/null -w '%{content_type}' "$claude/4")" "text/markdown"
check "a payload in a sandbox" "$(curl -s -o /dev/null -w '%header{content-security-policy}' "$claude/5")" sandbox
check "fetch unjoined" "$(status "$link/5")" 403
check "fetch a join" "$(curl -s "$claude/1" | wc -c)" 0

curl -s "$claude?after=5" >"$work/waited" &
waiting=$!
until_receiving "$luis?after=0&wait=0" luis/claude
check "receiving" "$(curl -s "$luis?wait=0" | tail -1 | jq -c '.presence["luis/claude"]')" '{"read":5,"receiving":true}'
curl -s --data-binary 'Still there?' "$luis" >/dev/null
wait "$waiting"
check "a waiting receive wakes" "$(head -1 "$work/waited" | jq -r .text)" "Still there?"
check "not receiving" "$(curl -s "$luis?wait=0" | tail -1 | jq '.presence["luis/claude"].receiving')" false
check "receive from the read position" "$(curl -s "$claude?wait=0" | head -n -1 | jq -r .n | xargs)" 6
check "a receive from the read position acknowledges" "$(curl -s "$claude?wait=0" | tail -1 | jq '.presence["luis/claude"].read')" 6

check "wait returns presence alone" "$(curl -s "$claude?after=6&wait=1" | jq -c 'keys')" '["presence"]'

curl -s -o /dev/null -w '%{http_code}' "$claude?after=6" >"$work/replaced" &
waiting=$!
until_receiving "$luis?after=0&wait=0" luis/claude
curl -s "$claude?after=6&wait=0" >/dev/null
wait "$waiting"
check "a newer receive replaces" "$(cat "$work/replaced")" 409

check "own entries" "$(curl -s "$luis?after=2&wait=0&own=1" | head -n -1 | jq -r .n | xargs)" "3 4 5 6"

curl -s "$luis?after=6&own=1&presence=1" >"$work/stirred" &
waiting=$!
# The receive that stirs is the one that sees luis receiving.
until_receiving "$claude?after=6&wait=0" luis
wait "$waiting"
check "presence wakes" "$(jq -c 'keys' "$work/stirred")" '["presence"]'

curl -s -o /dev/null -w '%{http_code}' "$claude?after=6" >"$work/left" &
waiting=$!
until_receiving "$luis?after=0&wait=0" luis/claude
check "leave" "$(curl -s -X POST "$claude/leave")" '{"n":7}'
wait "$waiting"
check "leaving ends a receive" "$(cat "$work/left")" 200
check "leave twice" "$(curl -s -X POST "$claude/leave")" '{"n":7}'
check "receive after leaving" "$(status "$claude?wait=0")" 403
check "a name stays taken" "$(status -X POST "$link/join?as=luis/claude")" 409
check "rejoin" "$(curl -s -X POST "$claude/join" | jq -c '[.n, .read, .link == "'"$claude"'"]')" '[8,6,true]'
check "read position kept" "$(curl -s "$claude?after=0&wait=0" | tail -1 | jq '.presence["luis/claude"].read')" 6

trace='application/vnd.polylogue.voice.trace+json'
curl -s -H "Content-Type: $trace" --data-binary '[]' "$luis" >/dev/null
check "a skipped entry neither returns nor wakes" "$(curl -s "$claude?skip=application/vnd.polylogue.voice.trace&wait=1" | jq -c 'keys')" '["presence"]'
check "a skipped entry is acknowledged" "$(curl -s "$luis?wait=0" | tail -1 | jq '.presence["luis/claude"].read')" 9
curl -s "$claude?skip=audio/&skip=Application/VND.polylogue.voice.trace" >"$work/skipped" &
waiting=$!
until_receiving "$luis?after=0&wait=0" luis/claude
curl -s -H 'Content-Type: audio/wav' --data-binary 'RIFF' "$luis?filename=heard.wav" >/dev/null
curl -s -H "Content-Type: $trace" --data-binary '[]' "$luis" >/dev/null
check "skipped entries don't wake" "$(curl -s "$luis?wait=0" | tail -1 | jq '.presence["luis/claude"].receiving')" true
curl -s --data-binary 'Now.' "$luis" >/dev/null
wait "$waiting"
check "skip several, in any case" "$(head -n -1 "$work/skipped" | jq -r .n | xargs)" 12
check "skip from a position" "$(curl -s "$claude?after=9&skip=audio/&wait=0" | head -n -1 | jq -r .n | xargs)" "11 12"
check "skip nothing" "$(status "$claude?skip=&wait=0")" 400

voice='only=application/vnd.polylogue.voice.&skip=application/vnd.polylogue.voice.trace'
curl -s "$claude?$voice" >"$work/only" &
waiting=$!
until_receiving "$luis?after=0&wait=0" luis/claude
curl -s -H "Content-Type: $trace" --data-binary '[]' "$luis" >/dev/null
curl -s --data-binary 'Later.' "$luis" >/dev/null
check "what only leaves out doesn't wake" "$(curl -s "$luis?wait=0" | tail -1 | jq '.presence["luis/claude"].receiving')" true
curl -s -H 'Content-Type: application/vnd.polylogue.voice.tier+json' --data-binary '{}' "$luis" >/dev/null
wait "$waiting"
check "only and skip combine" "$(head -n -1 "$work/only" | jq -r .n | xargs)" 15
check "only several, in any case" "$(curl -s "$claude?after=9&only=audio/&only=TEXT/&wait=0" | head -n -1 | jq -r .n | xargs)" "10 12 14"
check "only nothing" "$(status "$claude?only=&wait=0")" 400

# The observer looks without stirring: from position 0, for presence.
observer=$(curl -s -X POST "$link/join?as=observer" | jq -r .link)
curl -s "$luis?after=16&own=1" >/dev/null &
paged=$!
curl -s "$claude?after=16" >"$work/answered" &
waiting=$!
until_receiving "$observer?after=0&presence=1&wait=0" luis
until_receiving "$observer?after=0&presence=1&wait=0" luis/claude
curl -s --data-binary 'Both here?' "$luis" >/dev/null
wait "$paged" "$waiting"
check "the receives an entry answers share the presence" "$(tail -1 "$work/answered" | jq '.presence.luis.receiving')" true
curl -s -X POST "$observer/leave" >/dev/null

check "join with no name" "$(status -X POST "$link/join")" 400
check "bad after" "$(status "$luis?after=x")" 400
check "no session" "$(status "$relay/v1/s/AAAAAAAAAAAAAAAAAAAAAA/join?as=luis" -X POST)" 404
check "older version" "$(status "$relay/s/AAAAAAAAAAAAAAAAAAAAAA/join?as=luis" -X POST)" 410
check "other version" "$(status "$relay/v0/s" -X POST)" 410
check "no entry" "$(status "$luis/99")" 404
head -c 10485761 /dev/zero >"$work/large"
check "too large" "$(status --data-binary @"$work/large" "$luis")" 413
check "any origin" "$(curl -s -o /dev/null -w '%header{access-control-allow-origin}' -X OPTIONS "$link")" '*'

curl -s -X POST "$luis/leave" >/dev/null
check "one left inside" "$(status "$claude/5")" 200
curl -s -X POST "$claude/leave" >/dev/null
check "the last to leave ends it" "$(status -X POST "$claude/join")" 404

trash "$work"
exit "$failed"
