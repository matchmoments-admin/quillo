-- 0083 — the Grow layer's explicit on/off choices (first-timer spec A11 ticket b, #592; flag ft_journey).
--
-- WHY. The first-timer redesign hides the "grow" areas (Property, Shares & investments, Business &
-- companies, Assets, Integrations, Extras, Savings, Advisers) until they matter. Owner ruling #535: a
-- layer appears only when the user SWITCHES it on, CONFIRMS a detection ("Looks like you have rental
-- income: add it?" → Yes), or already HAS data in it — never silently auto-on. Data presence is computed
-- on read (src/lib/grow.ts), so an existing tenant's properties/holdings/entities keep their layer visible
-- with no backfill and no row here. Only the user's explicit choices persist:
--   state 'on'  + source 'switched' — turned on in About you / the account menu's Grow switcher
--   state 'on'  + source 'detected' — said Yes to a detection suggestion
--   state 'off' + source 'switched' — turned it off again (also silences its suggestions)
--   state 'off' + source 'detected' — said No to the suggestion for FY `dismissed_fy` (start year); the
--                                     suggestion may come back in a later FY
-- `dismissed_fy` is the one addition to the spec's sketch: "No dismisses it for the FY" needs the FY.
--
-- Not a money table: a layer's visibility changes what the navigation SHOWS, never what is counted.
-- Additive and apply-once (CREATE TABLE IF NOT EXISTS). Tenant table → PURGE_TABLES + export.
-- JURISDICTION-NEUTRAL: names no country.

CREATE TABLE IF NOT EXISTS grow_layers (
  user_id      TEXT NOT NULL,
  layer        TEXT NOT NULL,              -- property | investments | business | assets | integrations | extras | savings | advisers
  state        TEXT NOT NULL,              -- on | off
  source       TEXT NOT NULL,              -- switched | detected
  dismissed_fy INTEGER,                    -- state 'off' + source 'detected': the FY (start year) the suggestion was declined for
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, layer)
);
