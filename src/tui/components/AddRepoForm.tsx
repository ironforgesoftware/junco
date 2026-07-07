import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextField } from "./TextField.js";

export function AddRepoForm({
  error,
  busyText,
  onSubmit,
  onCancel,
}: {
  error: string | null;
  /** Non-null while the App works ("cloning repository…", "validating…"). */
  busyText: string | null;
  onSubmit: (nwo: string, path: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [nwo, setNwo] = useState("");
  const [path, setPath] = useState("");
  const [field, setField] = useState<"nwo" | "path">("nwo");
  const busy = busyText !== null;

  useInput((_i, key) => {
    if (key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" borderStyle="double" paddingX={2} paddingY={1} minWidth={50}>
      <Text bold>add repo to watchlist</Text>
      <Box gap={1}>
        <Text dimColor>owner/repo:</Text>
        <TextField
          value={nwo}
          onChange={setNwo}
          onSubmit={() => setField("path")}
          focus={!busy && field === "nwo"}
          placeholder="acme/api"
        />
      </Box>
      <Box gap={1}>
        <Text dimColor>local clone:</Text>
        <TextField
          value={path}
          onChange={setPath}
          // An EMPTY path is a valid submit: the App clones into the managed
          // directory (<state_dir>/repos/<owner>/<repo>) for you.
          onSubmit={() => nwo.trim() && onSubmit(nwo.trim(), path.trim())}
          focus={!busy && field === "path"}
          placeholder="empty = clone for me · or ~/code/api"
        />
      </Box>
      {busyText && <Text color="cyan">{busyText}</Text>}
      {error && <Text color="red">{error}</Text>}
      <Text dimColor>enter next/submit · esc cancel</Text>
    </Box>
  );
}
