#!/usr/bin/env bash
# Mock gh for the amend-mode test. Supports:
#   gh repo view --json nameWithOwner -q .nameWithOwner
#   gh pr view <N> --repo <nwo> --json state,headRefName,baseRefName,isDraft,url,isCrossRepository
# Canned values via env:
#   FAKE_GH_NWO            default "test-owner/test-repo"
#   FAKE_GH_PR_HEAD        default "junco/existing"
#   FAKE_GH_PR_BASE        default "main"
#   FAKE_GH_PR_STATE       default "OPEN"
#   FAKE_GH_PR_URL         default "https://github.com/test-owner/test-repo/pull/42"
# Logs every call to $FAKE_GH_LOG if set.

if [[ -n "$FAKE_GH_LOG" ]]; then
    printf 'gh %s\n' "$*" >> "$FAKE_GH_LOG"
fi

if [[ "$1" == "repo" && "$2" == "view" ]]; then
    echo "${FAKE_GH_NWO:-test-owner/test-repo}"
    exit 0
fi

if [[ "$1" == "pr" && "$2" == "view" ]]; then
    # Output the JSON payload the worker expects
    cat <<JSON
{
  "state": "${FAKE_GH_PR_STATE:-OPEN}",
  "headRefName": "${FAKE_GH_PR_HEAD:-junco/existing}",
  "baseRefName": "${FAKE_GH_PR_BASE:-main}",
  "isDraft": true,
  "url": "${FAKE_GH_PR_URL:-https://github.com/test-owner/test-repo/pull/42}",
  "isCrossRepository": false
}
JSON
    exit 0
fi

if [[ "$1" == "pr" && "$2" == "create" ]]; then
    # Should NOT be called in amend mode — if it is, fail loudly.
    echo "fake_gh_amend: pr create should not be invoked during amendment" >&2
    exit 2
fi

echo "fake_gh_amend: unhandled command: $*" >&2
exit 2
