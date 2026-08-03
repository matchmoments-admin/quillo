# Quillo (tax-agent) — agent instructions

**Read [`CLAUDE.md`](./CLAUDE.md). It is the single source of truth for this repo, for every
agent and every human.**

## Why this file is a pointer and not a copy

Two hand-maintained copies of the same guide is documentation drift waiting to happen — the
copy is always the one that goes stale, and a steering file asserting something false is worse
than none. This portfolio keeps one master (`CLAUDE.md`) and points everything else at it.
(The convention comes from a real drift incident in a sibling repo; see ask-arthur's
`AGENTS.md` for the post-mortem.)

Operational conventions live in `docs/` (personas, ADRs as `docs/adr-NNNN-*.md`, threshold
register) and `docs/agents/` (issue tracker, triage labels, domain-doc conventions).
