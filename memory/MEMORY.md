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
- Readiness + GET /api/journey composition live in src/lib (filing-readiness.ts computeFilingReadiness, journey-read.ts readJourney; DO methods delegate) — test them directly instead of replicating the DO. scripts/e2e-first-timer.ts is the 4-step journey e2e; its flag-OFF baseline re-captures with UPDATE_SNAPSHOT=1. [src: 3d49246d-fc0d-40f9-86a3-ad884ecefa78]

## Gotchas
- Fiskil sandbox+prod share ONE base URL and the JWT has no env marker, so FISKIL_ENV alone can't prove data is synthetic — PS8 carve-out also keys on sandbox institution `88888` (bank-feed-core requiresAuResidency). [src: 3d49246d-fc0d-40f9-86a3-ad884ecefa78]
- Fiskil API: end users are NOT unique per email (never retry create); `DELETE /consent/{id}` returns 204 even for unknown ids; `from`/`to` must be RFC3339 (bare dates 400); a bad `page[after]` returns 503 not 400; pin `X-Fiskil-Version: v3`. Full list: docs/bank-feed-provider-options.md §7. [src: 3d49246d-fc0d-40f9-86a3-ad884ecefa78]
- Parallel-agent squash merges can silently REVERT earlier PRs: #619 deleted all of #581 (minimise.ts, 0081, flag, goldens) while prod D1 kept the tables; restored in #639. Before building on a "closed" ticket, confirm its files exist on main (`git log --oneline -- <file>`). [src: 3d49246d-fc0d-40f9-86a3-ad884ecefa78]

## Preferences
- Owner (2026-10-04): the ft_journey redesign changes components + journey clarity ONLY, never production's look — reuse ui.tsx's exported BUTTON_TONE/CARD_CLASS/INPUT_CLASS; no accent/quiet/Geist roles (check-units "journey visual parity" enforces). [src: 3d49246d-fc0d-40f9-86a3-ad884ecefa78]

## Domain
