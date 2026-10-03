-- 0087 — fy_signoff.lodged_at: the user's own "I've lodged this year" mark (#572, first-timer spec A1 ticket b).
--
-- WHY. A first-timer prepares the year being LODGED, not the calendar's current FY: in October 2026 that's
-- 2025-26, until they lodge it, then 2026-27 (#536). Quillo can't lodge (no self-lodge API, #530), so the only
-- signal is the user telling us. `lodged_at` records it; `lodgingFy` (src/lib/lodging-year.ts) reads it to pick
-- the default FY, and the bank-data minimisation (A5) reads it to know when irrelevant debits may shrink.
--
-- Written ONLY by POST/DELETE /api/lodged (flag situation_profile). NULL = not lodged. It is independent of the
-- NOA close (status = 'closed_with_noa'): undoing a NOA resets status to 'lodged' instead of deleting the row
-- when lodged_at is set, so the lodged mark survives.
--
-- Additive and apply-once: ALTER TABLE ADD COLUMN. fy_signoff is already in PURGE_TABLES (and so in the export).
-- Moved out of 0078 by #571; the spec's appendix numbers after it shift (this is the next free number).

ALTER TABLE fy_signoff ADD COLUMN lodged_at TEXT;
