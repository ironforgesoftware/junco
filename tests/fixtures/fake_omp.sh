#!/usr/bin/env bash
# Mock omp for smoke tests. Real omp reads the prompt from @<file> (positional
# argv) and streams JSONL events in print mode. We emit a minimal but complete
# event sequence: session, message_start/end with a tool-call turn,
# message_start/end with the final text, turn_end carrying per-turn usage, and
# an agent_end with the canonical messages array.

prompt=""
for arg in "$@"; do
    if [[ "$arg" == @* ]]; then
        path="${arg:1}"
        if [[ -f "$path" ]]; then
            prompt="$(cat "$path")"
            break
        fi
    fi
done

prompt_bytes="${#prompt}"

sleep 0.3

FAKE_OMP_PROMPT_BYTES="$prompt_bytes" python3 - <<'PY'
import json, os
bytes_ = int(os.environ.get("FAKE_OMP_PROMPT_BYTES", "0"))
final_text = f"fake-omp ack. prompt bytes={bytes_}"

emit = lambda o: print(json.dumps(o))

emit({"type": "session", "id": "fake", "timestamp": "2026-04-22T00:00:00Z", "cwd": "/tmp"})

# Turn 1: tool-only (toolCall in message_end, paired turn_end)
tool_msg = {
    "role": "assistant",
    "content": [{"type": "toolCall", "id": "c1", "name": "read", "arguments": {"path": "/tmp/x"}}],
    "stopReason": "toolUse",
    "usage": {"input": 30, "output": 10, "cacheRead": 100, "cacheWrite": 0, "totalTokens": 140},
}
emit({"type": "message_start", "message": {"role": "assistant", "content": [], "model": "mock"}})
emit({"type": "message_end", "message": tool_msg})
emit({"type": "turn_end", "message": tool_msg, "toolResults": []})

# Turn 2: final text
final_msg = {
    "role": "assistant",
    "content": [{"type": "text", "text": final_text}],
    "stopReason": "stop",
    "usage": {"input": 12, "output": 7, "cacheRead": 50, "cacheWrite": 0, "totalTokens": 69},
}
emit({"type": "message_start", "message": {"role": "assistant", "content": [], "model": "mock"}})
emit({"type": "message_end", "message": final_msg})
emit({"type": "turn_end", "message": final_msg, "toolResults": []})

# Session wrap-up with canonical messages
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
