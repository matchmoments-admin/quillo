-- 0069 (audit wave 4, PR-10): record WHICH parcel-selection method a CGT disposal used.
-- NULL = specific identification (today's implicit semantics — the user manually enters the cost
-- base of the parcels they chose). 'fifo' records a first-in-first-out choice. RECORD-KEEPING ONLY:
-- src/lib/cgt.ts never reads it (auto-computing FIFO cost bases would be a separate money-output
-- feature). Surfaced via the API/UI/accountant schedule only when the cgt_parcel_method flag is on.
ALTER TABLE cgt_events ADD COLUMN method TEXT;
