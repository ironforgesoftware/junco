/**
 * The tool subset a session gets when it must not mutate the checkout: Q&A
 * tickets (no worktree — a stray write/bash/edit could corrupt the claimed
 * ticket sitting in processing/), the assess/analyze repo flows, and the
 * dashboard chat. A leaf module so runOnce, the flows, and the chat can all
 * import it without a cycle.
 */
export const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
