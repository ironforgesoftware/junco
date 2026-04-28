#!/usr/bin/env bash
# Mock gh CLI used by test_pr_flow. Supports the two subcommands the worker
# invokes: `gh repo view --json nameWithOwner -q .nameWithOwner` and
# `gh pr create ...`. Logs every call to $FAKE_GH_LOG if set.

if [[ -n "$FAKE_GH_LOG" ]]; then
    printf 'gh %s\n' "$*" >> "$FAKE_GH_LOG"
fi

if [[ "$1" == "repo" && "$2" == "view" ]]; then
    # The worker queries for nameWithOwner. Return a canned value.
    echo "${FAKE_GH_NWO:-test-owner/test-repo}"
    exit 0
fi

if [[ "$1" == "pr" && "$2" == "create" ]]; then
    # Emit a canned URL on the last line of stdout.
    echo "${FAKE_GH_PR_URL:-https://github.com/test-owner/test-repo/pull/42}"
    exit 0
fi

echo "fake_gh: unhandled command: $*" >&2
exit 2
