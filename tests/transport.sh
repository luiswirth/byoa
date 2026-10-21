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

for _ in $(seq 60); do
  curl -sf -o /dev/null "$relay/agents.md" && break
  sleep 0.5
done

check "the spec at /agents.md" "$(curl -s "$relay/agents.md" | head -1)" "# The byoa transport"

link=$(curl -s -X POST "$relay/s")
check "create" "$(status -X POST "$link/join?as=luis")" 200
check "join twice" "$(curl -s -X POST "$link/join?as=luis")" '{"n":1}'
check "send unjoined" "$(status --data-binary 'Hi.' "$link?as=claude")" 403
check "join another" "$(curl -s -X POST "$link/join?as=claude")" '{"n":2}'

check "send text" "$(curl -s --data-binary 'Hello.' "$link?as=luis")" '{"n":3}'
printf '**Notes**\n' >"$work/notes.md"
check "send markdown" "$(curl -s -H 'Content-Type: text/markdown' --data-binary @"$work/notes.md" "$link?as=luis")" '{"n":4}'
head -c 70000 /dev/urandom >"$work/plot.png"
check "send a file" "$(curl -s -H 'Content-Type: image/png' --data-binary @"$work/plot.png" "$link?as=luis&filename=plot.png")" '{"n":5}'

received=$(curl -s "$link?as=claude&after=0&wait=0")
check "receive others' entries" "$(head -n -1 <<<"$received" | jq -r .n | xargs)" "1 3 4 5"
check "inline text" "$(jq -r 'select(.n == 3) | .text' <<<"$received")" "Hello."
check "default type" "$(jq -r 'select(.n == 3) | .type' <<<"$received")" "text/plain; charset=utf-8"
check "no inline binary" "$(jq -r 'select(.n == 5) | [.text, .filename, .size] | join(" ")' <<<"$received")" " plot.png 70000"
check "presence last" "$(tail -1 <<<"$received" | jq -c '.presence | keys')" '["claude","luis"]'

curl -s -o "$work/fetched.png" "$link/5?as=claude"
check "fetch a payload" "$(cmp -s "$work/plot.png" "$work/fetched.png" && echo same)" same
check "fetch a type" "$(curl -s -o /dev/null -w '%{content_type}' "$link/4?as=claude")" "text/markdown"
check "fetch unjoined" "$(status "$link/5?as=nobody")" 403
check "fetch a join" "$(curl -s "$link/1?as=claude" | wc -c)" 0

curl -s "$link?as=claude&after=5" >"$work/waited" &
waiting=$!
sleep 1
check "receiving" "$(curl -s "$link?as=luis&wait=0" | tail -1 | jq -c .presence.claude)" '{"read":5,"receiving":true}'
curl -s --data-binary 'Still there?' "$link?as=luis" >/dev/null
wait "$waiting"
check "a waiting receive wakes" "$(head -1 "$work/waited" | jq -r .text)" "Still there?"
check "not receiving" "$(curl -s "$link?as=luis&wait=0" | tail -1 | jq .presence.claude.receiving)" false

check "wait returns presence alone" "$(curl -s "$link?as=claude&after=6&wait=1" | jq -c 'keys')" '["presence"]'

curl -s -o /dev/null -w '%{http_code}' "$link?as=claude&after=6" >"$work/replaced" &
waiting=$!
sleep 1
curl -s "$link?as=claude&after=6&wait=0" >/dev/null
wait "$waiting"
check "a newer receive replaces" "$(cat "$work/replaced")" 409

check "own entries" "$(curl -s "$link?as=luis&after=2&wait=0&own=1" | head -n -1 | jq -r .n | xargs)" "3 4 5 6"

curl -s "$link?as=luis&after=6&own=1&presence=1" >"$work/stirred" &
waiting=$!
sleep 1
curl -s "$link?as=claude&after=6&wait=0" >/dev/null
wait "$waiting"
check "presence wakes" "$(jq -c 'keys' "$work/stirred")" '["presence"]'

curl -s -o /dev/null -w '%{http_code}' "$link?as=claude&after=6" >"$work/left" &
waiting=$!
sleep 1
check "leave" "$(curl -s -X POST "$link/leave?as=claude")" '{"n":7}'
wait "$waiting"
check "leaving ends a receive" "$(cat "$work/left")" 200
check "leave twice" "$(curl -s -X POST "$link/leave?as=claude")" '{"n":7}'
check "receive after leaving" "$(status "$link?as=claude&wait=0")" 403
check "rejoin" "$(curl -s -X POST "$link/join?as=claude")" '{"n":8}'
check "read position kept" "$(curl -s "$link?as=claude&after=0&wait=0" | tail -1 | jq .presence.claude.read)" 6

check "no name" "$(status "$link?wait=0")" 400
check "bad after" "$(status "$link?as=luis&after=x")" 400
check "no session" "$(status "$relay/s/AAAAAAAAAAAAAAAAAAAAAA?as=luis")" 404
check "no entry" "$(status "$link/99?as=luis")" 404
head -c 10485761 /dev/zero >"$work/large"
check "too large" "$(status --data-binary @"$work/large" "$link?as=luis")" 413
check "any origin" "$(curl -s -o /dev/null -w '%header{access-control-allow-origin}' -X OPTIONS "$link")" '*'

curl -s -X POST "$link/leave?as=luis" >/dev/null
check "one left inside" "$(status "$link/5?as=claude")" 200
curl -s -X POST "$link/leave?as=claude" >/dev/null
check "the last to leave ends it" "$(status -X POST "$link/join?as=claude")" 404

trash "$work"
exit "$failed"
