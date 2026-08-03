# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the
actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `needs-decision`     | Requires owner sign-off — touches money/tax output or is net-new. **Never auto-closed** (see CLAUDE.md Issue hygiene). |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

These compose with the label families already in use here — `severity:{blocker,high,medium,low}`,
`area:*`, `priority:{p1,p2,p3}`, `epic` — which are defined in CLAUDE.md's **Issue hygiene**
section and remain authoritative for backlog management. Triage roles classify readiness; the
existing families classify what and how urgent.
