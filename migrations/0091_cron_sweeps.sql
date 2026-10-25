-- 0091 — the weekly sweep's state moves from KV to one D1 row (review of the D1 scale programme).
--
-- WHY. The sweep's lease was a KV get-then-put: KV is eventually consistent (reads up to ~60s stale), so two
-- ticks could both see no lease and run the same 400-tenant slice in parallel — duplicate nudges, a double
-- tally, racing bank-minimisation writes. The Monday start also went through that lease, so a slice still
-- running at 08:00 silently skipped the week. One D1 row fixes both: the lease is a conditional UPDATE that
-- exactly one tick wins, the start is independent of it, and the lifecycle tally accumulates per sweep.
--
-- Platform state (no user_id): one row per sweep name. Additive and apply-once.

CREATE TABLE IF NOT EXISTS cron_sweeps (
  name         TEXT PRIMARY KEY,     -- 'weekly'
  cursor       TEXT,                 -- NULL = idle; a user_id ('' = from the start) = in progress
  tally_json   TEXT,                 -- the LifecycleTally accumulated over this sweep's slices
  started_at   TEXT,
  lease_holder TEXT,                 -- the tick currently running a slice
  lease_until  TEXT                  -- the lease lapses at this time (a crashed tick can't hold it forever)
);
