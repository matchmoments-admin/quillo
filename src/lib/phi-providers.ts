import type { Env } from "../env";

/**
 * INTERIM "where can I spend my extras?" provider finder (flag `phi_provider_directory`, #314).
 *
 * Given an extras-category provider noun (from `providerSearchTerm`, e.g. "physiotherapist") and a
 * 4-digit postcode, return a FACTUAL, neutral list of nearby providers of that type — name, address,
 * phone, website. This is information display, identical in kind to the live Healthdirect signpost it
 * augments: NO ranking/recommendation/commission, NO "accepts your fund" claim, no clinical advice.
 *
 * Source is Geoapify Places (OSM-derived, on commercial managed infra whose ToS explicitly permit
 * caching/storing results — the reason it's chosen over Google/Foursquare/HERE). The key stays
 * server-side; only postcode + service type ever leave Quillo (no identity/fund/ledger — matches the
 * NO-PII referral precedent). NHSD/Healthdirect FHIR later drops into THIS SAME seam + neutral shape
 * (ref SD-207047, ~3 months) — only `fetchProviders`' body changes, no UI/route/shape change.
 *
 * Keystone: Geoapify has no granular allied-health categories. Dental uses the
 * `categories=healthcare.dentist` filter; every other allied-health noun uses Geoapify `name=` text
 * search. Both are scoped to the postcode centroid (geocoded via Geoapify) with a radius filter + bias.
 */

/** Provider-agnostic shape. Deliberately carries NO place_id / category / ranking field — NHSD must be
 *  able to populate the identical shape, and a score field would invite "best for you" steering. */
export type Provider = { name: string; address: string; phone?: string; website?: string };

/** The Geoapify free-plan attribution obligations (all three) — rendered verbatim on the list surface. */
export const GEOAPIFY_ATTRIBUTION = {
  text: "Powered by Geoapify · © OpenStreetMap contributors",
  href: "https://www.geoapify.com/",
} as const;

const PLACES_RADIUS_M = 15000; // ~15km around the postcode centroid — metro-tight, covers regional towns.
const MAX_RESULTS = 20; // 1 Geoapify credit per 20 results; a single category lookup stays at 1 credit.

/** Dental categories map to the only relevant Geoapify category; everything else has none. */
function isDentalTerm(providerTerm: string): boolean {
  return /dentist|orthodontist/i.test(providerTerm);
}

/**
 * Build the Geoapify Places query string for a provider noun around a centroid. PURE (no network) so
 * the dental-category-vs-name-search split is unit-assertable. Dental → the `healthcare.dentist`
 * category filter; all other allied-health → a `name=` text search (no Geoapify category exists for
 * them). Both scoped to a circle around the centroid + proximity bias, capped at MAX_RESULTS.
 */
export function geoapifyPlacesQuery(providerTerm: string, lon: number, lat: number): string {
  const p = new URLSearchParams();
  if (isDentalTerm(providerTerm)) {
    p.set("categories", "healthcare.dentist");
  } else {
    p.set("name", providerTerm);
  }
  p.set("filter", `circle:${lon},${lat},${PLACES_RADIUS_M}`);
  p.set("bias", `proximity:${lon},${lat}`);
  p.set("limit", String(MAX_RESULTS));
  return p.toString();
}

/** A minimal view of the Geoapify FeatureCollection we depend on (other fields ignored). */
type GeoapifyFeature = {
  properties?: {
    name?: unknown;
    formatted?: unknown;
    address_line2?: unknown;
    contact?: { phone?: unknown };
    phone?: unknown;
    website?: unknown;
    datasource?: { raw?: { website?: unknown; phone?: unknown } };
  };
};
type GeoapifyFeatureCollection = { features?: GeoapifyFeature[] };

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Normalise a Geoapify Places FeatureCollection to the neutral `Provider[]` shape. PURE + deterministic
 * (the unit-golden target). Drops nameless features (a result with no provider name is unusable), maps
 * only the neutral fields, preserves API order (distance — never re-ranked), and caps at MAX_RESULTS.
 */
export function normaliseGeoapify(payload: GeoapifyFeatureCollection | null | undefined): Provider[] {
  const feats = Array.isArray(payload?.features) ? payload!.features! : [];
  const out: Provider[] = [];
  for (const f of feats) {
    const pr = f?.properties ?? {};
    const name = str(pr.name);
    if (!name) continue; // unnamed POI — not a usable listing
    const address = str(pr.formatted) ?? str(pr.address_line2) ?? "";
    const phone = str(pr.contact?.phone) ?? str(pr.phone) ?? str(pr.datasource?.raw?.phone);
    const website = str(pr.website) ?? str(pr.datasource?.raw?.website);
    out.push({ name, address, ...(phone ? { phone } : {}), ...(website ? { website } : {}) });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

/** Geocode a 4-digit AU postcode to a centroid via Geoapify. Returns null on miss/error. */
async function geocodePostcode(apiKey: string, postcode: string): Promise<{ lon: number; lat: number } | null> {
  const p = new URLSearchParams({
    text: postcode,
    filter: "countrycode:au",
    type: "postcode",
    limit: "1",
    apiKey,
  });
  const res = await fetch(`https://api.geoapify.com/v1/geocode/search?${p.toString()}`);
  if (!res.ok) {
    // Surface auth/quota failures (401 bad key, 429 over-limit) — otherwise they're indistinguishable
    // from a genuine coverage gap. Behaviour is unchanged (caller falls back to Healthdirect).
    console.warn(`[phi-providers] geocode failed: ${res.status}`);
    return null;
  }
  const j = (await res.json()) as GeoapifyFeatureCollection & {
    features?: { geometry?: { coordinates?: unknown } }[];
  };
  const coords = j.features?.[0]?.geometry?.coordinates;
  if (!Array.isArray(coords) || typeof coords[0] !== "number" || typeof coords[1] !== "number") return null;
  return { lon: coords[0], lat: coords[1] };
}

/**
 * Fetch nearby providers of `providerTerm` around `postcode`. Server-side: the GEOAPIFY_KEY never
 * reaches the SPA. Cached 24h in the RULES KV under a NON-user-scoped key (`provider_term:postcode`,
 * no PII) — Geoapify's ToS permit caching/storing results. Any failure (no key, geocode miss, fetch
 * error) returns [] so the UI shows the Healthdirect signpost as the primary CTA rather than a blank.
 */
export async function fetchProviders(env: Env, providerTerm: string, postcode: string): Promise<Provider[]> {
  const apiKey = env.GEOAPIFY_KEY;
  if (!apiKey) return [];

  const cacheKey = `phi:providers:${providerTerm}:${postcode}`;
  try {
    const cached = await env.RULES.get(cacheKey, "json");
    if (cached) return cached as Provider[];

    const centroid = await geocodePostcode(apiKey, postcode);
    if (!centroid) return [];

    const q = geoapifyPlacesQuery(providerTerm, centroid.lon, centroid.lat);
    const res = await fetch(`https://api.geoapify.com/v2/places?${q}&apiKey=${encodeURIComponent(apiKey)}`);
    if (!res.ok) {
      // Don't cache an error as if it were "no providers" — only cache a real parsed result below.
      console.warn(`[phi-providers] places failed: ${res.status}`);
      return [];
    }
    const providers = normaliseGeoapify((await res.json()) as GeoapifyFeatureCollection);

    // Cache even an empty result (24h) — a genuine coverage gap shouldn't re-hit Geoapify on every tap.
    await env.RULES.put(cacheKey, JSON.stringify(providers), { expirationTtl: 60 * 60 * 24 });
    return providers;
  } catch (e) {
    console.warn(`[phi-providers] fetch error: ${(e as Error).message}`);
    return []; // network/parse failure — UI falls back to Healthdirect
  }
}
