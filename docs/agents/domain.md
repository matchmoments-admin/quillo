# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root (the domain glossary; upstream renamed it from `CONTEXT.md` in
  v1.3.0, and the skills no longer look for the old name), or
- **`GLOSSARY-MAP.md`** at the repo root if it exists. It points at one `GLOSSARY.md` per context. Read
  each one relevant to the topic.
- **The ADRs**, flat in `docs/` as `docs/adr-NNNN-<title>.md`. Read the ones that touch the area you're
  about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved. Today this repo has no `GLOSSARY.md` yet.

## File structure

This is a single-context repo:

```
/
├── GLOSSARY.md                                   ← created lazily
├── docs/
│   ├── adr-0001-do-write-coordinator-d1-ceiling.md
│   ├── adr-0002-canonical-sources.md
│   ├── adr-0003-bank-feed-cdr-access.md
│   └── adr-0004-life-situation-modules.md
└── src/
```

ADRs live flat in `docs/`, **not** under `docs/adr/`. Continue the `adr-NNNN-<title>.md` sequence and
naming when recording a new decision.

If the repo ever splits into several contexts, a `GLOSSARY-MAP.md` at the root points at one
`GLOSSARY.md` per context, and system-wide ADRs stay flat in `docs/`.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0002 (canonical sources) — but worth reopening because…_
