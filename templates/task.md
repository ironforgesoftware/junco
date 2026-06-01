---
id: <% tp.date.now("YYYY-MM-DD-HHmm") %>-<% tp.file.title %>
created: <% tp.date.now("YYYY-MM-DDTHH:mm:ss") %>
priority: normal
timeout_minutes: 30
---

# <% tp.file.title %>

Describe the task here. The body (everything after the frontmatter closing
`---`) is sent verbatim to the configured coding agent as the prompt. Wikilinks
like [[Some Other Note]] are passed through unchanged — the agent can resolve
them if relevant.
