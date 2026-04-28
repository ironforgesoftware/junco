#!/usr/bin/env bash
# Mock omp for the PR-flow test: reads prompt from @<file>, makes a real file
# change in its cwd (the worktree), commits it, then emits a valid JSONL stream.

prompt=""
for arg in "$@"; do
    if [[ "$arg" == @* ]]; then
        path="${arg:1}"
        [[ -f "$path" ]] && prompt="$(cat "$path")"
    fi
done

prompt_bytes="${#prompt}"

# Simulate real work: add a file and commit it, in the current worktree.
echo "junco says hi" > HELLO.md
git -c user.email=ci@example.com -c user.name=CI \
    -c commit.gpgsign=false \
    add HELLO.md
git -c user.email=ci@example.com -c user.name=CI \
    -c commit.gpgsign=false \
    commit -q -m "Add HELLO.md" >/dev/null 2>&1 || true

sleep 0.1

FAKE_OMP_PROMPT_BYTES="$prompt_bytes" python3 - <<'PY'
import json, os
bytes_ = int(os.environ.get("FAKE_OMP_PROMPT_BYTES", "0"))
final_text = f"Committed HELLO.md. prompt bytes={bytes_}"

emit = lambda o: print(json.dumps(o))

emit({"type": "session", "id": "fake", "timestamp": "2026-04-22T00:00:00Z"})
tool_msg = {
    "role": "assistant",
    "content": [{"type": "toolCall", "id": "c1", "name": "bash", "arguments": {"command": "git commit ..."}}],
    "stopReason": "toolUse",
    "usage": {"input": 20, "output": 5, "cacheRead": 10, "cacheWrite": 0, "totalTokens": 35},
}
emit({"type": "message_start", "message": {"role": "assistant", "content": [], "model": "mock"}})
emit({"type": "message_end", "message": tool_msg})
emit({"type": "turn_end", "message": tool_msg, "toolResults": []})

final_msg = {
    "role": "assistant",
    "content": [{"type": "text", "text": final_text}],
    "stopReason": "stop",
    "usage": {"input": 10, "output": 8, "cacheRead": 20, "cacheWrite": 0, "totalTokens": 38},
}
emit({"type": "message_start", "message": {"role": "assistant", "content": [], "model": "mock"}})
emit({"type": "message_end", "message": final_msg})
emit({"type": "turn_end", "message": final_msg, "toolResults": []})
emit({
    "type": "agent_end",
    "messages": [
        {"role": "user", "content": [{"type": "text", "text": "prompt"}]},
        tool_msg,
        final_msg,
    ],
})
PY

exit 0
