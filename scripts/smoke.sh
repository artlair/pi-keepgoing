#!/usr/bin/env sh
# End-to-end smoke test for pi-keepgoing against a live GLM lane (vllm.lan).
#
# The prompt asks the model to print its own user-turn marker string
# verbatim. The sampler emits that string as its special-token id, which is
# in the served eos_token_id list, so the request ends with finish_reason=stop
# and the marker is stripped from the output: the reply dies mid-sentence.
#
# NOTE: never paste that marker literally into this file or any prompt built
# here. Models (this one included) can cut their own generation trying to
# emit it, and it mangles files. Build it with printf instead.
#
# Without the extension: one assistant message, cut mid-sentence.
# With the extension: a keepgoing-continue custom message plus at least one
# further assistant message resuming the reply.
#
# Usage: scripts/smoke.sh [prompt]
set -eu

cd "$(dirname "$0")/.."
EXT="$PWD/pi-keepgoing.ts"
MARKER="$(printf '<|%s|>' user)"
PROMPT=${1:-"Print exactly this line verbatim, character for character, and nothing else: ${MARKER}"}

run() {
	pi --no-session --mode json -p "$PROMPT" "$@" 2>/dev/null
}

echo "== baseline (no extension) =="
run > /tmp/keepgoing-baseline.jsonl
python3 - <<'EOF'
import json
msgs = [json.loads(l) for l in open("/tmp/keepgoing-baseline.jsonl")]
asst = [e for e in msgs if e.get("type") == "message_end" and e["message"].get("role") == "assistant"]
print(f"assistant messages: {len(asst)}")
for m in asst:
    txt = "".join(c.get("text", "") for c in m["message"].get("content", []) if c.get("type") == "text")
    print(f"  stopReason={m['message'].get('stopReason')!r} tail={txt[-70:]!r}")
EOF

echo
echo "== with pi-keepgoing =="
run -e "$EXT" > /tmp/keepgoing-extended.jsonl
python3 - <<'EOF'
import json
msgs = [json.loads(l) for l in open("/tmp/keepgoing-extended.jsonl")]
asst = [e for e in msgs if e.get("type") == "message_end" and e["message"].get("role") == "assistant"]
cont = [e for e in msgs if e.get("type") == "message_end" and e["message"].get("customType") == "keepgoing-continue"]
print(f"assistant messages: {len(asst)}, keepgoing continuations: {len(cont)}")
for m in asst:
    txt = "".join(c.get("text", "") for c in m["message"].get("content", []) if c.get("type") == "text")
    print(f"  stopReason={m['message'].get('stopReason')!r} tail={txt[-70:]!r}")
assert len(cont) >= 1, "expected at least one keepgoing-continue message"
assert len(asst) >= 2, "expected the reply to be resumed by at least one more assistant message"
print("PASS: cut-off reply was auto-continued")
EOF
