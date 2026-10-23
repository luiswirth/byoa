#!/bin/sh
# The byoa script, run with plain sh against the relay at $1.
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
luis() { XDG_STATE_HOME=$work/luis BYOA_RELAY=$relay sh byoa "$@"; }
claude() { XDG_STATE_HOME=$work/claude BYOA_RELAY=$relay sh byoa "$@"; }

check "served at /byoa" "$(curl -s "$relay/byoa" | cmp - byoa && echo same)" same

token=$(luis new)
check "new" "$(printf %s "$token" | grep -cE '^[A-Za-z0-9_-]{22}$')" 1
check "join" "$(luis join "$token" 'Luis W.')" '{"n":1}'
check "join a link" "$(claude join "$relay/s/$token" luis/claude)" '{"n":2}'
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

claude join "$token" luis/claude >/dev/null
check "join again goes on" "$(claude receive "$token" --wait 0 | wc -l | tr -d ' ')" 1
XDG_STATE_HOME=$work/claude BYOA_RELAY=$relay sh byoa join "$token" other >/dev/null
check "several here need --as" "$(claude receive "$token" --wait 0 2>&1)" "byoa: several joined this session here: give --as <name>"
check "--as" "$(echo 'Me.' | claude send "$token" --as other)" '{"n":7}'
check "leave" "$(claude leave "$token" --as other)" '{"n":8}'

check "no session" "$(luis join AAAAAAAAAAAAAAAAAAAAAA x 2>&1)" "byoa: no such session"
check "not joined" "$(luis send "$(luis new)" </dev/null 2>&1)" "byoa: not joined: sh byoa join <token> <name>"
check "leave" "$(claude leave "$token")" '{"n":9}'
check "left" "$(claude receive "$token" 2>&1)" "byoa: not joined: sh byoa join <token> <name>"
luis leave "$token" >/dev/null

exit $failed
