#!/bin/sh
# The polylogue script, run with plain sh against the relay at $1.
set -eu

relay=${1:-http://localhost:8790}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failed=0

check() {
  if [ "$2" = "$3" ]; then
    echo "ok    $1"
  else
    echo "FAIL  $1: got '$2', expected '$3'"
    failed=1
  fi
}

# Two machines, each with a state of its own.
luis() { XDG_STATE_HOME=$work/luis POLYLOGUE_RELAY=$relay sh polylogue "$@"; }
claude() { XDG_STATE_HOME=$work/claude POLYLOGUE_RELAY=$relay sh polylogue "$@"; }

check "served at /polylogue" "$(curl -s "$relay/polylogue" | cmp - polylogue && echo same)" same

link=$(luis new 'Luis W.')
check "new" "$(printf %s "$link" | grep -cE "^$relay/v1/s/[A-Za-z0-9_-]{22}\$")" 1
token=${link##*/}
check "new joins" "$(luis receive "$token" --wait 0 | tail -n 1 | grep -o '"Luis W."')" '"Luis W."'
check "a name taken" "$(claude join "$token" 'Luis W.' 2>&1)" "polylogue: Luis W. is taken in this session"
check "join a link" "$(claude join "$link" luis/claude | cut -c1-37)" '{"n":2,"name":"luis/claude","read":0,'
check "send" "$(echo 'Hello.' | luis send "$token")" '{"n":3}'
check "send markdown" "$(echo '**Hi.**' | luis send "$token" --type text/markdown)" '{"n":4}'
printf 'a,b\n1,2\n' >"$work/data.csv"
check "send a file" "$(luis send "$token" "$work/data.csv")" '{"n":5}'

out=$(claude receive "$token")
check "receive" "$(printf '%s\n' "$out" | sed -n 2p | grep -o '"from":"Luis W.".*"text":"Hello.\\n"')" '"from":"Luis W.","type":"text/plain; charset=utf-8","size":7,"text":"Hello.\n"'
check "receive a file" "$(printf '%s\n' "$out" | sed -n 4p | grep -o '"filename":"data.csv"')" '"filename":"data.csv"'
check "presence last" "$(printf '%s\n' "$out" | tail -n 1 | cut -c1-12)" '{"presence":'
check "receive goes on" "$(claude receive "$token" --wait 0 | wc -l | tr -d ' ')" 1
check "fetch" "$(claude fetch "$token" 5)" "$(cat "$work/data.csv")"
claude fetch "$token" 5 "$work/got.csv"
check "fetch to a file" "$(cmp "$work/data.csv" "$work/got.csv" && echo same)" same

check "join again while in" "$(claude join "$token" luis/claude | cut -c1-37)" '{"n":2,"name":"luis/claude","read":5,'
check "join again goes on" "$(claude receive "$token" --wait 0 | wc -l | tr -d ' ')" 1
XDG_STATE_HOME=$work/claude POLYLOGUE_RELAY=$relay sh polylogue join "$token" other >/dev/null
check "several here need --as" "$(claude receive "$token" --wait 0 2>&1)" "polylogue: several joined this session here: give --as <name>"
check "--as" "$(echo 'Me.' | claude send "$token" --as other)" '{"n":7}'
check "leave" "$(claude leave "$token" --as other)" '{"n":8}'
check "join again after leaving" "$(claude join "$token" other | cut -c1-31)" '{"n":9,"name":"other","read":0,'
me=$(sed -n 3p "$work/claude/polylogue/$token"/*"$(printf other | od -An -tx1 -v | tr -d ' \n')")
check "join with an own link" "$(luis join "$me" | cut -c1-31)" '{"n":9,"name":"other","read":0,'
check "an own link here" "$(echo 'Mine.' | luis send "$token" --as other)" '{"n":10}'
check "leave the own link" "$(luis leave "$token" --as other)" '{"n":11}'
claude receive "$token" --as luis/claude --wait 0 >/dev/null
echo '[]' | luis send "$token" --as 'Luis W.' --type application/vnd.polylogue.voice.trace+json >/dev/null
check "receive --skip" "$(claude receive "$token" --as luis/claude --skip application/vnd.polylogue.voice.trace --wait 0 | wc -l | tr -d ' ')" 1
echo '[]' | luis send "$token" --as 'Luis W.' --type application/vnd.polylogue.voice.trace+json >/dev/null
check "receive --only" "$(claude receive "$token" --as luis/claude --only text/ --wait 0 | wc -l | tr -d ' ')" 1

check "no session" "$(luis join AAAAAAAAAAAAAAAAAAAAAA x 2>&1)" "polylogue: no such session"
check "not joined" "$(luis send "$(curl -s -X POST "$relay/v1/s")" </dev/null 2>&1)" "polylogue: not joined: sh polylogue join <link> <name>"
check "several here need --as" "$(claude leave "$token" 2>&1)" "polylogue: several joined this session here: give --as <name>"
check "leave" "$(claude leave "$token" --as luis/claude)" '{"n":14}'
check "left" "$(claude receive "$token" --as luis/claude 2>&1)" "polylogue: you have left: join again with POST <your link>/join"
luis leave "$token" --as "Luis W." >/dev/null

exit $failed
