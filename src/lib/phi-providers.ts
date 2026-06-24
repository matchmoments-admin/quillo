import type { Env } from "../env";

/**
 * INTERIM "where can I spend my extras?" provider finder (flag `phi_provider_directory`, #314).
 *
 * Given an extras-category provider noun (from `providerSearchTerm`, e.g. "physiotherapist") and a
 * 4-digit postcode, return a FACTUAL, neutral list of nearby providers of that type — name, address,
 * phone, website. Information display, identical in kind to the live Healthdirect signpost it augments:
 * NO ranking/recommendation/commission, NO "accepts your fund" claim, no clinical advice.
 *
 * Source is **Google Places Text Search (New)**. We started on Geoapify (OSM-derived) but it has NO
 * allied-health place categories — only dentist/pharmacy/hospital/clinic_or_praxis(doctor specialties)
 * — so ~10 of the 14 extras categories (physio, chiro, podiatry, acupuncture, dietetics, …) returned
 * zero even in dense metro. Google has real allied-health place types and full AU coverage. The key
 * stays server-side; only postcode + service type ever leave Quillo (no identity/fund/ledger).
 *
 * Google ToS: place IDs may be cached, but other Places content may NOT be stored — so there is NO KV
 * cache here (one live call per explicit user Search; volume is tiny). NHSD/Healthdirect FHIR later
 * drops into THIS SAME seam + neutral shape (ref SD-207047, ~3mo) — only this body changes.
 */

/** Provider-agnostic shape. Deliberately carries NO Google place_id / rating field — NHSD must populate
 *  the identical shape, and a score field would invite "best for you" steering. lat/lng are optional
 *  generic geo (used only to build a maps deep-link client-side). */
export type Provider = { name: string; address: string; phone?: string; website?: string; lat?: number; lng?: number };

/** Attribution shown on the list surface. Google requires "Powered by Google" when Places data is shown
 *  without a Google map. */
export const PROVIDER_ATTRIBUTION = {
  text: "Powered by Google",
  href: "https://www.google.com",
} as const;

const MAX_RESULTS = 20;
const DEFAULT_MAX_SEARCHES_PER_DAY = 200; // safe default per tenant when PHI_PROVIDER_MAX_PER_DAY is unset

/**
 * Per-tenant daily cap on provider searches — a cheap server-side guardrail so a buggy/abusive client
 * can't spin the Google Places meter. Mirrors the KV-counter pattern in usage.ts (lossy under high
 * concurrency, which is fine here — the Google-side daily quota is the hard global ceiling; this just
 * stops one tenant running away). `PHI_PROVIDER_MAX_PER_DAY` overrides the default; "0" = unlimited.
 * Returns true if the call is allowed (and counts it), false if the tenant is over today's cap.
 */
export async function withinProviderSearchCap(env: Env, userId: string): Promise<boolean> {
  const cap = env.PHI_PROVIDER_MAX_PER_DAY != null && env.PHI_PROVIDER_MAX_PER_DAY !== ""
    ? Number(env.PHI_PROVIDER_MAX_PER_DAY)
    : DEFAULT_MAX_SEARCHES_PER_DAY;
  if (!Number.isFinite(cap) || cap <= 0) return true; // 0/invalid ⇒ unlimited (matches env convention)
  try {
    const day = new Date().toISOString().slice(0, 10);
    const key = `phi:providers:count:${userId}:${day}`;
    const cur = Number((await env.RULES.get(key)) ?? 0);
    if (cur >= cap) return false;
    await env.RULES.put(key, String(cur + 1), { expirationTtl: 60 * 60 * 26 });
    return true;
  } catch {
    return true; // never let a KV hiccup block a legitimate search — the Google quota is the hard cap
  }
}

/**
 * The Google Places Text Search query for a provider noun near a postcode. PURE (no network) so it's
 * unit-assertable. "near {postcode} Australia" lets Google geocode the area itself — no separate
 * geocoding call, and no hard distance cap (Google ranks by relevance/proximity).
 */
export function googleTextQuery(providerTerm: string, postcode: string): string {
  return `${providerTerm} near ${postcode} Australia`;
}

/** A minimal view of the Google `places:searchText` response we depend on (other fields ignored). */
type GooglePlace = {
  displayName?: { text?: unknown };
  formattedAddress?: unknown;
  nationalPhoneNumber?: unknown;
  internationalPhoneNumber?: unknown;
  websiteUri?: unknown;
  location?: { latitude?: unknown; longitude?: unknown };
};
type GoogleSearchResponse = { places?: GooglePlace[] };

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Normalise a Google `places:searchText` response to the neutral `Provider[]` shape. PURE +
 * deterministic (the unit-golden target). Drops nameless places, maps only the neutral fields,
 * preserves Google's order (relevance/distance — never re-ranked), and caps at MAX_RESULTS.
 */
export function normaliseGoogle(payload: GoogleSearchResponse | null | undefined): Provider[] {
  const places = Array.isArray(payload?.places) ? payload!.places! : [];
  const out: Provider[] = [];
  for (const p of places) {
    const name = str(p?.displayName?.text);
    if (!name) continue; // unnamed place — not a usable listing
    const address = str(p.formattedAddress) ?? "";
    const phone = str(p.nationalPhoneNumber) ?? str(p.internationalPhoneNumber);
    const website = str(p.websiteUri);
    const lat = num(p.location?.latitude);
    const lng = num(p.location?.longitude);
    out.push({
      name,
      address,
      ...(phone ? { phone } : {}),
      ...(website ? { website } : {}),
      ...(lat != null && lng != null ? { lat, lng } : {}),
    });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

/**
 * Fetch nearby providers of `providerTerm` around `postcode` via Google Places Text Search. Server-side:
 * GOOGLE_PLACES_KEY never reaches the SPA. The FieldMask requests only the neutral fields (the cheap
 * SKU). No caching (Google ToS). Any failure (no key, fetch error, non-OK) returns [] so the UI shows
 * the "Open in Maps" + Healthdirect fallback rather than a blank.
 */
export async function fetchProviders(env: Env, providerTerm: string, postcode: string): Promise<Provider[]> {
  const apiKey = env.GOOGLE_PLACES_KEY;
  if (!apiKey) {
    // Not configured — UI falls back to maps + Healthdirect. Warn so a missing/unpropagated secret
    // is never silent: a 200 with `providers: []` is otherwise indistinguishable from a coverage gap.
    console.warn("[phi-providers] GOOGLE_PLACES_KEY not set — returning [] (UI falls back to Maps + Healthdirect)");
    return [];
  }

  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        // Minimal mask = the cheap Text Search SKU. Requesting more fields raises the per-call price.
        "X-Goog-FieldMask":
          "places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.location",
      },
      body: JSON.stringify({
        textQuery: googleTextQuery(providerTerm, postcode),
        regionCode: "AU",
        languageCode: "en",
        maxResultCount: MAX_RESULTS,
      }),
    });
    if (!res.ok) {
      // Surface auth/quota failures (e.g. 403 bad key, 429 over-limit) — otherwise they're
      // indistinguishable from a genuine coverage gap. Behaviour unchanged (UI falls back).
      console.warn(`[phi-providers] google searchText failed: ${res.status}`);
      return [];
    }
    return normaliseGoogle((await res.json()) as GoogleSearchResponse);
  } catch (e) {
    console.warn(`[phi-providers] fetch error: ${(e as Error).message}`);
    return []; // network/parse failure — UI falls back to maps + Healthdirect
  }
}
