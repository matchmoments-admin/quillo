# Plan: getting a Quillo user's return lodged by a registered tax agent

Status: recommended 2026-10-24 (map #692). Builds on [lodgement-options.md](lodgement-options.md) (#786),
[become-tax-agent.md](become-tax-agent.md) and the money principle recorded on #542.
General information only. Nothing here is legal advice; the legal points go to #524.

## The recommendation in one line

**Start with one partner agent, built in the shape of a panel.** One anchor registered agent (plus a
backup) lodges for Quillo users at a fixed, published price that the user pays to the agent directly. The
handoff is built so that adding a second agent is a data change, not a code change. It grows into a small
curated panel (3 to 5 agents) only when a trigger below fires. Quillo registering as its own agent is
parked until volume justifies it.

## Why not the other two shapes first

| Shape | What it gets right | Why it isn't first |
|---|---|---|
| **Open marketplace** (many agents, bidding or ranking) | Choice, price competition | Quillo has one tenant, so it starts with no users for agents and no agents for users. Ranking agents makes Quillo responsible for the order (ACL misleading conduct, TPB). Ratings mean nothing until there are dozens of reviews. Bidding pulls price down and pushes claims up. It is also a lot of product to build before anyone has used the handoff once. |
| **Quillo becomes the agent** (company registration with a contracted supervising agent) | Quillo controls the experience and keeps the fee | 2 to 4 months, PI insurance, the TPB Code across the whole business, and agent liability on every Quillo output. Owning the app and the practice is a conflict that has to be disclosed. It only pays at volume. |
| **One partner, panel-shaped** (this plan) | Live in weeks, no liability moved onto Quillo, one relationship to get right, and the partner's corrections teach us where the pack is weak | Single point of dependence and peak-season capacity. Hence the backup agent and the panel triggers. |

A marketplace with one agent in it is a partner. So the question is really *when* to add the second agent
and *how* the user chooses between them, and both are answered below.

## How it works for the user

1. On the Lodge step the user sees two options:
   - **Lodge it yourself in myTax (free).** This is the myTax mirror, live today.
   - **Have a registered tax agent lodge it.** It shows the agent's name, TPB registration number, fixed price
     tiers, typical turnaround and how it works.
2. **Consent screen.** It lists exactly what is shared, with whom, why, and for how long:
   - the accountant schedule (CSV/XLSX, already built);
   - the myTax figures;
   - the WFH diary CSV;
   - the receipts and documents.

   The user can untick evidence groups. No TFN is sent; the agent collects it in their own onboarding.
3. **The agent gets a secure link.** It is read-only, expires in 30 days, can be revoked, and every view and
   download is logged. The user can see the log.
4. **The agent does what only an agent can.** They take the user on as a client, verify identity, collect the
   TFN, review the figures, take the signed declaration and lodge through PLS. They invoice the user
   directly.
5. **Status comes back** through the same link: accepted → needs info (with a message to the user) →
   lodged on a date. "Lodged" sets the existing mark-as-lodged on that year. The Notice of Assessment arrives
   later through the normal document upload.
6. **The user rates the experience** (private for now, used to manage the partner).

The copy says plainly that Quillo doesn't lodge returns or give tax advice, that the agent is an
independent registered tax agent, and that Quillo receives no payment from the agent. Final wording goes
to the lawyer review (#524).

**A real selling point, to verify with the partner:** people on a registered agent's client list by
31 October usually get the agent lodgement program's later due dates (often into the following May)
instead of 31 October. That is the main reason a late-season user would pick this door.

## Money

- **The user pays the agent directly**, on the agent's own invoice. Quillo never holds the money.
- **Quillo takes no fee in the pilot**, which is the principle already recorded on #542. It keeps Quillo
  outside "fee or reward for a tax agent service" and keeps the agent's referral-disclosure duty simple.
  Quillo's value is that a user who finishes their year in Quillo can always get it lodged, which is a
  retention and conversion feature.
- **Later and optional:** a flat listing fee paid by each panel agent, never tied to the outcome or the
  refund, and disclosed on the card. Whether to charge one is an owner decision with the lawyer, taken at
  the panel stage.

## Choosing the anchor partner (owner outreach)

**Must have:**
- current TPB registration (checked on the public register and re-checked yearly);
- PI insurance;
- based in Australia, with client data stored in Australia;
- already onboards clients remotely, including identity checks and e-signed declarations;
- uses SBR-enabled practice software;
- experience with rental properties and WFH claims (the core personas);
- capacity from July to October.

**What we ask of them:**
- publish fixed price tiers we can show: salary + deductions; + rental property; + sole trader;
- acknowledge within 2 business days, and lodge within 10 business days of having complete information;
- accept the Quillo pack as the input and tell us what was wrong or missing in it. That feedback is worth as
  much as the lodgements;
- a short collaboration agreement covering data handling: storage in Australia, deletion, breach notice,
  no onward use. It contains no referral payment.

**Backup agent:** the same profile, used when the anchor is full or unavailable.

## When the partner becomes a panel

Add agents, up to 3 to 5, when any of these happens:

- the anchor misses the turnaround promise in a peak week;
- more than about 50 handoffs in a month (an estimate; revisit with real data);
- 3 or more users ask for something the anchor can't offer (a language, in-person meetings, a specialty such
  as crypto or a company);
- the anchor leaves or its registration lapses.

**Panel rules:**
- Agents are listed in a neutral order (rotated) and can be filtered by need: price tier, language, remote
  or in person, specialty.
- They are **never ranked by refund, claim size or "return rate"**. That invites aggressive claims and
  breaks Quillo's never-predict-a-refund rule.
- Ratings are shown only once an agent has at least 10.
- A Quillo-affiliated practice can only join with the conflict disclosed on its card, and it is never
  pinned to the top.

## Data and privacy

- **Disclosure basis.** Sharing with the agent is a disclosure the user consents to, for a purpose they
  asked for. The privacy policy needs a line about it (#524). Because the agent is Australian, no overseas
  disclosure is involved.
- **Bank-feed (CDR) data.** It is excluded from the pack until Fiskil confirms how a CDR Representative may
  pass CDR-derived data to a user's nominated registered agent ("trusted adviser"). The question is added
  to #702. Bank feeds are off today (`bank_feed_cdr`), so the pilot loses nothing.
- **Security.** The share link is a bearer token: Quillo stores only its hash, and it is scoped to one
  user and one year. It expires, can be revoked, is rate-limited, and every use is logged. The pen-test
  scope (`docs/security/pen-test-scope.md`) gains this surface.

## Build sketch

Everything is additive and behind the flag `agent_handoff`, which is OFF by default.

- **The panel** is a small typed config (`src/content/tax-agents.ts`: key, name, TPB number, tiers,
  turnaround, languages, contact address, active). It is reference data, not a tenant table; 1 to 5 agents
  don't need a database.
- **`agent_handoffs`** table:
  - `user_id`, `fy`, `agent_key`;
  - `consent_text_hash`, `consented_at`, `scope_json`;
  - `token_hash`, `expires_at`, `revoked_at`;
  - `status`, `status_at`, `lodged_at`, `rating`, `created_at`.
- **`agent_handoff_events`**: an access and status audit log with `user_id`.
- Both tables go into `PURGE_TABLES`, and the migration is the next `00NN_`.
- **Agent view:** the share link opens a read-only page showing the schedule, the files and a status form.
  There are **no agent accounts**: B2B is out of scope on map #692, and agent logins (Clerk orgs) belong
  to the panel stage.
- **Reuse:**
  - `buildAccountantSchedule` / `scheduleToXlsx` for the figures;
  - the myTax mirror for the figure list;
  - the WFH diary export;
  - R2 for the evidence;
  - `/api/lodged` for the lodged mark.
- **Tests:**
  - a QA journey for consent → link → agent marks lodged → the year shows lodged;
  - goldens for token expiry, revocation and cross-tenant refusal;
  - personas stay green. No money output changes.

## Timeline

| When | What |
|---|---|
| Nov–Dec 2026 | Owner shortlists and approaches agents. Lawyer reviews the copy, the privacy line and the agreement. Fiskil answers the CDR question. A prototype of the two options and the consent screen is clicked through. |
| Jan–Feb 2027 | Build behind the flag; the pen test covers the share link. |
| Mar–May 2027 | Pilot with the anchor on prior-year and late returns (agents lodge prior years at any time), plus the owner's own test run. |
| From 1 Jul 2027 | Turned on for everyone for tax time 2027. |

## Parked (decide later, not now)

- **Quillo's own agent practice**, the company route in [become-tax-agent.md](become-tax-agent.md): revisit
  if the handoffs per season make an in-house practice pay. It would join the panel as one disclosed member.
- **Payments through Quillo** (Stripe Connect with the agent as merchant of record): only if agents ask for
  it.
- **Agent accounts and multi-client views:** these come with the panel.
