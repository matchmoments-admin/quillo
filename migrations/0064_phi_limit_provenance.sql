-- 0064: pooled limits + provenance on phi_limit (prerequisite for auto-source / upload-extract).
-- WHY: real extras policies SHARE one limit across several services (e.g. physiotherapy + chiropractic
-- + osteopathy draw on ONE $750 pool; natural therapies share $400 with a remedial-massage sub-limit).
-- The per-single-category model would count each service's limit separately and OVER-STATE available
-- cover (3 × $750 = $2,250 instead of $750). `combined_group` ties pooled categories to one shared
-- limit so the overview counts it once. Provenance (`source`/`verified`) lets a sourced/extracted limit
-- be shown for confirmation (verified=0) until the member confirms it (verified=1).
-- Additive + apply-once (ALTER ADD COLUMN). Inert until a producer sets the columns ⇒ byte-identical.
ALTER TABLE phi_limit ADD COLUMN combined_group TEXT;                 -- shared-pool id; NULL = standalone category
ALTER TABLE phi_limit ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'; -- 'manual' | 'sourced' (PHIS dataset) | 'extracted' (uploaded doc)
ALTER TABLE phi_limit ADD COLUMN verified INTEGER NOT NULL DEFAULT 1;   -- 1 = member-confirmed; 0 = awaiting confirmation (sourced/extracted)
