#!/usr/bin/env bash
# Mock omp for the "aborted-partial salvage" test.
#
# Simulates the real-world failure we just debugged: agent makes a real commit,
# then its NEXT streaming turn gets into a text-repetition loop. The worker's
# RepetitionGuard should kill it mid-stream. With the Phase-5 fixes, the
# pushed+PR'd branch should still be surfaced as `aborted_partial` in done/.

# Drain the @<path> arg.
for arg in "$@"; do :; done

# Simulate real work: add a file and commit it, in the current worktree.
echo "junco says hi" > HELLO.md
git -c user.email=ci@example.com -c user.name=CI \
    -c commit.gpgsign=false add HELLO.md
git -c user.email=ci@example.com -c user.name=CI \
    -c commit.gpgsign=false commit -q -m "Add HELLO.md" >/dev/null 2>&1 || true

python3 - <<'PY'
import json, sys, time

def emit(o):
    print(json.dumps(o)); sys.stdout.flush()

emit({"type": "session", "id": "fake-loopy"})

# Turn 1: a real toolCall (bash/commit) — productive.
tool_msg = {
    "role": "assistant",
    "content": [{"type": "toolCall", "id": "c1", "name": "bash",
                 "arguments": {"command": "git add HELLO.md && git commit -m 'Add HELLO.md'"}}],
    "stopReason": "toolUse",
    "usage": {"input": 20, "output": 8, "totalTokens": 28},
}
emit({"type": "message_start", "message": {"role": "assistant", "content": []}})
emit({"type": "message_end", "message": tool_msg})
emit({"type": "turn_end", "message": tool_msg})

# Turn 2: stream a message_update with a long, highly-repetitive thinking block.
# The RepetitionGuard should trip and the worker should kill this process.
emit({"type": "message_start", "message": {"role": "assistant", "content": []}})
# Build a looping thinking paragraph (>= threshold repeats of a >= 80-char probe)
para = ("The next step is to update App.tsx for routing. Let me think carefully "
        "about the ordering here before writing the edit tool call. ")
cumulative = ""
for i in range(12):  # 12 reps of a ~120-char para = ~1440 chars, fits the guard window
    cumulative += para
    emit({"type": "message_update",
          "message": {"role": "assistant",
                      "content": [{"type": "thinking", "thinking": cumulative}]}})
    time.sleep(0.08)

# If we get here the guard didn't fire — sleep so the test's wall clock can measure the regression.
time.sleep(30)
emit({"type": "agent_end", "messages": []})
PY

exit 0
