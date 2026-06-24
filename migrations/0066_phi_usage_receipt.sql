-- Snap-to-log claims: retain the scanned receipt's R2 object key alongside the logged benefit usage,
-- so a claim keeps its evidence (the receipt the OCR read). Additive + apply-once.
ALTER TABLE phi_benefit_usage ADD COLUMN receipt_key TEXT;
