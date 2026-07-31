# Privacy Safeguard 8 — entity test or location test?

> **Research deliverable for [#474](https://github.com/matchmoments-admin/quillo/issues/474)**, map
> [#473](https://github.com/matchmoments-admin/quillo/issues/473). Produced 2026-08-01.
>
> ⚠️ **This is engineering input, NOT legal advice.** Every conclusion below must be confirmed by an
> Australian privacy/CDR lawyer before anything is signed or migrated. Where I am confident I say so;
> where the answer turns on facts I cannot verify (Cloudflare's and AWS's contractual terms) I say that
> too. Quillo is not a registered tax agent and does not lodge.

---

## 0 · The answer in one paragraph

**Neither, and that is the finding.** PS8 turns on **effective control** — *where the recipient is
located and whether the disclosing entity retains control*, not on where the bytes physically rest.
An overseas-headquartered company using Australian infrastructure **may still be an "overseas
recipient."** Therefore **the proposed D1 → Turso-AU / Aurora migration does not, on its own, resolve
PS8** — Turso, AWS and Cloudflare are all US-incorporated, so moving the bytes to Sydney changes the
data's location without changing who the recipient is. The migration is **necessary-but-not-sufficient
at best, and possibly not necessary at all.** The realistic compliant path is a PS8 *exception*, which
is a contractual and legal-opinion cost — **not a re-platform.**

## 1 · What PS8 actually says

An accredited data recipient **must not disclose CDR data to a recipient located overseas** (other
than the CDR consumer) unless an exception applies. Three exceptions:

| # | Exception | Usable for Quillo? |
|---|---|---|
| 1 | The overseas recipient is **also an accredited person** | ❌ Cloudflare/AWS are not CDR-accredited |
| 2 | The ADR takes **reasonable steps to ensure the overseas recipient will not breach** the privacy safeguards (penalty provisions) | ✅ **This is the one.** Contractual + technical controls |
| 3 | The ADR reasonably believes the recipient is subject to an **equivalent law or binding scheme**, with mechanisms the consumer can enforce | ➖ Unlikely for the US; possible in principle |

**Consumer consent is NOT an exception.** This is the sharpest divergence from APP 8, where consent
*is* a valid basis for cross-border disclosure. ADR-0003 stated this correctly and it is confirmed:
**a consumer cannot consent their way past PS8.**

PS8 applies to accredited data recipients — and, via the representative arrangement, to a CDR
representative "as if it were" one.

## 2 · The question the ticket asked — resolved

> *Does an AU-region deployment of a US-incorporated vendor satisfy PS8?*

**No, not by itself.** APP 8 (and PS8, which is stricter) turn on **where the recipient is located,
not only where the data is physically stored**. An overseas-headquartered company using Australian
infrastructure may still be an overseas recipient **depending on where control of the data sits**.

The practical test is whether the vendor can access the data from outside Australia. Cloudflare Inc.
and AWS can. Sydney-region storage does not change that.

**Consequence:** the "move D1 to an AU region" wave, as specced, would have been a multi-month, high-risk
migration of the system of record that **did not answer the question it was designed to answer.**
Catching this before the migration is the whole value of this ticket.

## 3 · The cheap hypothesis — refuted

I flagged, as the highest-value possibility on this map, that **naming Cloudflare and AWS as OSPs under
Rule 1.10 might make the current architecture compliant with no migration at all.**

**It does not.** OAIC's outsourcing guidance is explicit: a CDR outsourcing arrangement **does not
avoid PS8**. The principal remains liable for the OSP's conduct, and an OSP may only handle data in
accordance with the arrangement *and the relevant safeguards* — PS8 among them. Tellingly, the
guidance requires a principal to specify in its CDR policy "the countries in which those OSPs are
**likely to be based**" where data may be disclosed overseas: OSP status is a *disclosure-governance*
mechanism, not an exemption from the overseas rule.

So OSP naming is **necessary** (it is how the arrangement legitimately covers Cloudflare and AWS at
all) but **not sufficient**. Both obligations apply simultaneously.

Also confirmed from the same source: **a CDR representative must not engage an OSP to *collect* CDR
data**, and may engage one for *use/disclosure* only where the representative arrangement permits it.
ADR-0003 had this right.

## 4 · The "use not disclosure" escape — and why it is architecturally shut

There is a genuine route by which handing data to a cloud host is a **use** rather than a
**disclosure**, which would take it outside PS8 entirely. OAIC's condition:

> It constitutes a *use* rather than a *disclosure* **only if the data remains encrypted at all times,
> and the third party does not hold or have access to the decryption keys.**

More broadly, providing data to an overseas contractor can be a *use* where the entity **does not
release the subsequent handling from its effective control** — which requires a binding contract.

**Quillo cannot satisfy the encryption limb, and the reason is structural rather than a coding
problem.** Categorisation needs plaintext transaction descriptions, so the Worker must decrypt. And the
Worker *is* Cloudflare — **there is nowhere to put a key that Cloudflare cannot reach while Cloudflare
runs the compute.** End-to-end encryption is unavailable to this architecture, not merely unbuilt.
Moving only the *database* off Cloudflare does not change that, because the decrypting compute stays.

The "effective control" limb, however, remains open and is not an encryption question — it is a
contractual one, and it is the same territory as exception 2.

## 5 · The three real options

| | Option | What it costs | Residual risk |
|---|---|---|---|
| **A** | **Stay on Cloudflare.** Rely on PS8 exception 2 — "reasonable steps" via contract, plus Bedrock `au.` for inference | **A legal opinion and vendor paperwork.** No migration | Depends entirely on whether Cloudflare's and AWS's terms can support "reasonable steps" + the principal accepting it |
| **B** | **Move to AU-controlled infrastructure** — compute *and* store, not just the database | Very high. And **the same PS8 analysis still applies to AWS** unless the provider is genuinely AU-controlled | Lower, if the provider is Australian-incorporated |
| **C** | **Don't do CDR.** Statement upload forever, invest in the review flow instead | Zero engineering | The onboarding friction stays — the thing the feed was meant to remove |

**Option A is the one to test first**, because its cost is a lawyer's time rather than a re-platform,
and because **Option B does not escape the analysis anyway** while it stays on AWS. Note the asymmetry:
if A fails, B is still available; if you do B first and A would have worked, the migration was wasted.

**What makes A live or dead is a fact I cannot check:** whether Cloudflare and AWS will contract to
terms that let Quillo (or its principal ADR) demonstrate "reasonable steps to ensure the overseas
recipient will not breach the privacy safeguards." That is a question for the vendors and the
principal, and it composes directly with
[#475](https://github.com/matchmoments-admin/quillo/issues/475).

## 6 · What does NOT change

**Bedrock `au.` remains a hard prerequisite under every option.** Sending CDR-derived transaction text
to a US model is a disclosure to an overseas recipient on any reading — entity, location or effective
control — and consent cannot cure it. `assertAuResidency` (`src/llm.ts:71`) is correctly fail-closed
with no flag and no fallback. [#476](https://github.com/matchmoments-admin/quillo/issues/476) is
unaffected by this finding and should proceed.

The 24-month wall, read-only-forever, and statement-upload-stays-first-class all stand.

## 7 · Confidence

| Claim | Confidence |
|---|---|
| Consent is not a PS8 exception | **High** — stated directly in OAIC guidance, and the sharpest APP 8 divergence |
| The three exceptions as listed | **High** |
| OSP naming does not avoid PS8 | **High** — OAIC outsourcing guidance is explicit |
| A representative must not engage an OSP to *collect* | **High** |
| AU region alone doesn't satisfy the test for a foreign-controlled vendor | **Medium-high** — well supported for APP 8 and PS8 is stricter, but the precise application to a Cloudflare-shaped arrangement is exactly what counsel must confirm |
| Exception 2 is practically reachable with Cloudflare/AWS terms | **Unknown** — depends on contracts I have not seen. **The decisive open question** |
| E2E encryption is architecturally unavailable while Cloudflare runs compute | **High** — follows from needing plaintext for categorisation |

## 8 · Recommended next steps

1. **Do not schedule the store migration.** It does not resolve PS8 on its own and may be unnecessary.
2. **Put exception 2 to a lawyer** — one question: *can Quillo, as a CDR representative, satisfy
   "reasonable steps" with Cloudflare as host and AWS Bedrock `ap-southeast-2` for inference?*
3. **Ask Basiq the same question in the [#475](https://github.com/matchmoments-admin/quillo/issues/475)
   conversation** — as principal they carry the liability, so their answer may settle it commercially
   before it needs settling legally. **A refusal here is more disqualifying than a high platform fee.**
4. **Proceed with [#476](https://github.com/matchmoments-admin/quillo/issues/476)** (Bedrock `au.`) —
   unaffected and required regardless.

---

*Sources: OAIC CDR Privacy Safeguard Guidelines Chapter 8 (Privacy Safeguard 8) and Chapter B (key
concepts); OAIC guidance on CDR outsourcing arrangements; OAIC APP Guidelines Chapter 8 (APP 8
cross-border disclosure). Verify against the current published versions before relying on any of it.*
