# Acceptable use policy (CDR data environment)

> Schedule 2 control 6(b): a policy on the CDR data environment that every person agrees to **before**
> getting access, and is regularly reminded of. Also supports 3(a) (data loss prevention). Version 0.1,
> 2026-10-08. Re-read and re-sign at each annual review (October).

Applies to anyone with access to Quillo's production systems, source code, administrative accounts or
any CDR data, including the director and any future employee or contractor.

## You must

1. Use only your own named accounts, with MFA on, and keep credentials in the approved password manager.
2. Access production data, and CDR data in particular, **only** for a specific, recorded purpose:
   a migration, an incident, a deletion directed by Fiskil, or a support request the consumer asked for.
   Prefer counts and ids over reading content.
3. Keep CDR data inside the CDR data environment ([cdr-data-environment.md](cdr-data-environment.md)).
4. Use devices that meet the [endpoint standard](endpoint-standard.md); lock your screen whenever you step away.
5. Follow the ship workflow for every change; never bypass CI gates or review rules.
6. Report any suspected incident, lost device, phishing click or exposed secret **immediately** to the
   incident lead ([incident-response-plan.md](incident-response-plan.md)), even if you caused it.
7. Complete security and privacy training before access and every year
   ([training-and-screening-record.md](training-and-screening-record.md)).

## You must not

1. Copy, download, export, screenshot, print, email or message CDR data or consumers' personal
   information outside production — including to your laptop, USB drives, personal cloud storage, chat
   apps, issue trackers, pull requests or documentation.
2. Paste CDR data, production rows, secrets or consumer personal information into AI assistants or any
   third-party tool that is not in the [OSP register](osp-register.md) for that data. AI coding agents work
   on code and synthetic data only.
3. Use production CDR data in local, preview or test environments, or as test fixtures.
4. Use CDR data for any purpose other than the service the consumer consented to (no marketing,
   analytics side projects, research or curiosity).
5. Share accounts, passwords or MFA devices, or disable MFA.
6. Add a new external service that receives personal or CDR data without updating the OSP register and,
   for CDR data, getting Fiskil's written approval first.
7. Install unapproved software on the admin device or bypass Gatekeeper.
8. Commit secrets to git or print them in logs.

## Consequences

Breaches of this policy are security incidents and are handled under the incident response plan. For
staff and contractors they may lead to removal of access and termination of engagement.

## Acknowledgement

I have read, understood and agree to follow this acceptable use policy.

| Name | Role | Signature | Date | Version |
|---|---|---|---|---|
| | Director | | | 0.1 |
