import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextField } from "./TextField.js";

export function AddRepoForm({
  error,
  busy,
  onSubmit,
  onCancel,
}: {
  error: string | null;
  busy: boolean;
  onSubmit: (nwo: string, path: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [nwo, setNwo] = useState("");
  const [path, setPath] = useState("");
  const [field, setField] = useState<"nwo" | "path">("nwo");

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
          onSubmit={() => nwo.trim() && path.trim() && onSubmit(nwo.trim(), path.trim())}
          focus={!busy && field === "path"}
          placeholder="~/code/api"
        />
      </Box>
      {busy && <Text color="cyan">validating…</Text>}
      {error && <Text color="red">{error}</Text>}
      <Text dimColor>enter next/submit · esc cancel</Text>
    </Box>
  );
}
