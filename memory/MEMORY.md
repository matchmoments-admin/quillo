# Memory index

Curated cross-session memory for this repo. How it works:

- One line per entry under the headings below, each tagged `[src: <session-id>]` so every
  belief traces to the transcript that produced it.
- Any session may **append** one-line entries directly when it learns something durable.
- **Bulk rewrites and consolidation happen only via `/dream`**, which opens a PR — the agent
  that wrote a dream never merges it. Human review is the guardrail against consolidating
  something wrong or poisoned.
- Keep this file under 200 lines. Detail that doesn't fit one line goes in a topic file
  (`memory/<topic>.md`) with a one-line pointer here. Superseded entries move to
  `memory/archive/`, not deleted.
- `memory/.scratch/` is gitignored per-session workspace.
- Never store secrets, tokens, or PII here.

## Build / tooling

## Gotchas

## Preferences

## Domain
