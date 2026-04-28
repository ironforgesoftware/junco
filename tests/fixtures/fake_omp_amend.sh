#!/usr/bin/env bash
# Mock omp for the amend-mode test: reads prompt, makes an additional file
# change (emulating "address review feedback"), commits it, emits JSONL.

prompt=""
for arg in "$@"; do
    if [[ "$arg" == @* ]]; then
        path="${arg:1}"
        [[ -f "$path" ]] && prompt="$(cat "$path")"
    fi
done

prompt_bytes="${#prompt}"

# Add an AMENDMENT: a second file on top of whatever's already there.
echo "addressing review feedback" > FEEDBACK.md
git -c user.email=ci@example.com -c user.name=CI \
    -c commit.gpgsign=false add FEEDBACK.md
git -c user.email=ci@example.com -c user.name=CI \
    -c commit.gpgsign=false commit -q -m "fix: address review feedback" >/dev/null 2>&1 || true

sleep 0.1

FAKE_OMP_PROMPT_BYTES="$prompt_bytes" python3 - <<'PY'
import json, os
bytes_ = int(os.environ.get("FAKE_OMP_PROMPT_BYTES", "0"))

def emit(o):
    print(json.dumps(o))

emit({"type": "session", "id": "fake-amend"})
tool_msg = {
    "role": "assistant",
    "content": [{"type": "toolCall", "id": "c1", "name": "bash", "arguments": {"command": "git commit ..."}}],
    "stopReason": "toolUse",
    "usage": {"input": 12, "output": 6, "totalTokens": 18},
}
emit({"type": "message_start", "message": {"role": "assistant", "content": []}})
emit({"type": "message_end", "message": tool_msg})
emit({"type": "turn_end", "message": tool_msg})

final_msg = {
    "role": "assistant",
    "content": [{"type": "text", "text": f"Amended PR. prompt bytes={bytes_}"}],
    "stopReason": "stop",
    "usage": {"input": 8, "output": 5, "totalTokens": 13},
}
emit({"type": "message_start", "message": {"role": "assistant", "content": []}})
emit({"type": "message_end", "message": final_msg})
emit({"type": "turn_end", "message": final_msg})
emit({
    "type": "agent_end",
    "messages": [
        {"role": "user", "content": [{"type": "text", "text": "amend prompt"}]},
        tool_msg,
        final_msg,
    ],
})
PY

exit 0
