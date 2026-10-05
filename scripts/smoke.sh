#!/usr/bin/env sh
# End-to-end smoke test for pi-keepgoing against a live GLM lane (vllm.lan).
#
# The prompt asks the model to write its own user-turn marker string inline,
# spelled out character by character so the prompt itself never contains it
# (a literal marker in the prompt is tokenized as the special token and the
# model never sees it). When the model emits the marker as its special-token
# id, which is in the served eos_token_id list, the request ends with
# finish_reason=stop and the token is stripped from the output: the reply
# dies mid-sentence. In practice this lands in the thinking block, right
# after the opening backtick the model writes before the marker, so the cut
# reply has no text at all.
#
# NOTE: never paste that marker literally into this file or any prompt built
# here. Models (this one included) can cut their own generation trying to
# emit it, and it mangles files.
#
# The cut is sampled, not guaranteed (roughly 40% of runs with the default
# prompt), so each phase retries up to $ATTEMPTS times until a cut shows up.
#
# Without the extension: one assistant message, cut mid-sentence.
# With the extension: a keepgoing-continue custom message plus at least one
# further assistant message resuming the reply. A run that cut (empty or
# thinking-only reply) without a continuation is a hard failure.
#
# Usage: scripts/smoke.sh [prompt]
set -eu

cd "$(dirname "$0")/.."
EXT="$PWD/pi-keepgoing.ts"
ATTEMPTS=${ATTEMPTS:-5}
OUT=${TMPDIR:-/tmp}/keepgoing-smoke
mkdir -p "$OUT"
PROMPT=${1:-"In one or two sentences, explain what GLM's chat template uses to mark the start of a user turn, and write that marker inline: it is the characters less-than, vertical bar, the word user, vertical bar, greater-than, joined with no spaces. Then add one more sentence about the assistant marker."}

run() {
	pi --no-session --mode json -p "$PROMPT" "$@" 2>/dev/null
}

# check MODE FILE: print a summary; exit 0 on success, 2 if the model did
# not cut this time (retry), 1 on a real failure.
check() {
	python3 - "$1" "$2" <<'EOF'
import json, sys
mode, path = sys.argv[1], sys.argv[2]
events = [json.loads(l) for l in open(path) if l.strip()]

def parts(m, kind):
    return "".join(c.get(kind, "") for c in m.get("content", []) if c.get("type") == kind)

def is_cut(m):
    # Text-less stops are what the extension always treats as cut.
    return m.get("stopReason") == "stop" and not parts(m, "text").strip()

asst, cont, first_run = [], 0, None
for e in events:
    if e.get("type") == "message_end" and e["message"].get("role") == "assistant":
        asst.append(e["message"])
    # Boundary drafts are committed as session entries, so they surface as
    # entry_appended events rather than message_end.
    if e.get("type") == "entry_appended" and e["entry"].get("customType") == "keepgoing-continue":
        cont += 1
        if first_run is None:
            first_run = asst[-1] if asst else None
print(f"assistant messages: {len(asst)}, keepgoing continuations: {cont}")
for m in asst:
    print(f"  stopReason={m.get('stopReason')!r} text_tail={parts(m, 'text')[-70:]!r} thinking_tail={parts(m, 'thinking')[-50:]!r}")
if not asst:
    print("no assistant message at all")
    sys.exit(1)
if first_run is None:
    first_run = asst[-1]
cut = is_cut(first_run)
if mode == "baseline":
    sys.exit(0 if cut else 2)
if cont >= 1:
    if len(asst) < 2 or asst.index(first_run) == len(asst) - 1:
        print("FAIL: continuation appended but no further assistant message")
        sys.exit(1)
    print("PASS: cut-off reply was auto-continued")
    sys.exit(0)
if cut:
    print("FAIL: reply was cut off but pi-keepgoing did not continue it")
    sys.exit(1)
sys.exit(2)
EOF
}

phase() {
	name=$1
	shift
	i=1
	while [ "$i" -le "$ATTEMPTS" ]; do
		echo "-- $name attempt $i/$ATTEMPTS"
		run "$@" > "$OUT/$name.jsonl"
		rc=0
		check "$name" "$OUT/$name.jsonl" || rc=$?
		[ "$rc" -eq 0 ] && return 0
		[ "$rc" -eq 1 ] && exit 1
		echo "   (model did not cut this time, retrying)"
		i=$((i + 1))
	done
	echo "$name: model never cut in $ATTEMPTS attempts; inconclusive"
	[ "$name" = baseline ] && return 0
	exit 1
}

echo "== baseline (no extension) =="
phase baseline

echo
# The extension is off by default (PI_KEEPGOING=1 opts in), so enable it
# explicitly for this phase.
echo "== with pi-keepgoing =="
PI_KEEPGOING=1 phase extended -e "$EXT"
