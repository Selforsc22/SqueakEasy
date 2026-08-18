// map-logic.js — pure functions shared by the browser page and the node:test suite.
// Nothing in here touches Leaflet, the DOM, localStorage, or the network. If a
// function needs the map object, it belongs in app.js.

/** Locked copy deck strings that logic needs to return. Section 4 of the spec. */
export const COPY = {
  tooFewScores: 'Needs 3 scores before we show an average.',
  emptyFilter: 'No curds match. Clear a filter and try again.',
  offline: 'Scores are taking a nap. The map still works.'
};

/** Minimum scores before an average is shown. */
export const MIN_SCORES = 3;

/** Valid price buckets. Anything else is treated as "no price filter". */
export const PRICES = ['$', '$$', '$$$'];

/**
 * Fallback view when there is nothing to fit: the Milwaukee metro.
 * ponytail: hardcoded box. Upgrade path is deriving it from the full
 * places.json once the real dataset lands, so the fallback follows the data.
 */
export const DEFAULT_BOUNDS = Object.freeze({
  south: 42.85,
  west: -88.35,
  north: 43.35,
  east: -87.75
});

/** Half-height/width added around a single point so bounds are never zero-area. */
const SINGLE_POINT_PAD = 0.02;

const FILTER_KEYS = ['q', 'price', 'county'];

/** Empty filter state. Every filter object has exactly these keys. */
export function emptyFilters() {
  return { q: '', price: '', county: '' };
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Narrow a list of places. Search matches name, city, and order, case-insensitive.
 * Price and county apply as AND alongside the query.
 * Always returns an array — never null, never undefined.
 */
export function filterPlaces(places, filters = {}) {
  if (!Array.isArray(places)) return [];

  const q = text(filters.q).trim().toLowerCase();
  const price = text(filters.price).trim();
  const county = text(filters.county).trim().toLowerCase();

  return places.filter((place) => {
    if (!place) return false;

    if (q) {
      const haystack = [place.name, place.city, place.order]
        .map((field) => text(field).toLowerCase())
        .join(' ');
      if (!haystack.includes(q)) return false;
    }

    if (price && text(place.price) !== price) return false;
    if (county && text(place.county).toLowerCase() !== county) return false;

    return true;
  });
}

/**
 * Read filter state out of a query string. Unknown params are dropped and junk
 * values fall back to empty rather than throwing.
 * Accepts "?q=x", "q=x", or a URLSearchParams.
 */
export function parseFilters(input) {
  const filters = emptyFilters();

  let params;
  try {
    params = input instanceof URLSearchParams
      ? input
      : new URLSearchParams(text(input).replace(/^[?#]/, ''));
  } catch {
    return filters;
  }

  for (const key of FILTER_KEYS) {
    const raw = params.get(key);
    if (typeof raw !== 'string') continue;
    filters[key] = raw.trim();
  }

  // A price we do not recognize is no filter at all.
  if (!PRICES.includes(filters.price)) filters.price = '';

  return filters;
}

/**
 * Write filter state back into a query string. Empty values are omitted so a
 * cleared filter leaves a clean URL. Round-trips through parseFilters unchanged.
 */
export function serializeFilters(filters = {}) {
  const params = new URLSearchParams();

  for (const key of FILTER_KEYS) {
    const value = text(filters[key]).trim();
    if (!value) continue;
    if (key === 'price' && !PRICES.includes(value)) continue;
    params.set(key, value);
  }

  return params.toString();
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Bounding box for a set of places, as { south, west, north, east }.
 * Empty (or all-unmappable) input returns DEFAULT_BOUNDS. A single place is
 * padded into a real box so the map does not zoom to a pinpoint.
 */
export function boundsOf(places) {
  const points = (Array.isArray(places) ? places : [])
    .filter((place) => place && isFiniteNumber(place.lat) && isFiniteNumber(place.lng));

  if (points.length === 0) return { ...DEFAULT_BOUNDS };

  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;

  for (const { lat, lng } of points) {
    if (lat < south) south = lat;
    if (lat > north) north = lat;
    if (lng < west) west = lng;
    if (lng > east) east = lng;
  }

  if (south === north) {
    south -= SINGLE_POINT_PAD;
    north += SINGLE_POINT_PAD;
  }
  if (west === east) {
    west -= SINGLE_POINT_PAD;
    east += SINGLE_POINT_PAD;
  }

  return { south, west, north, east };
}

/**
 * Render a score entry for display: "4.2 · 37 scores".
 * Truncates rather than rounds, so 4.25 reads 4.2 and never flatters a place.
 * Missing entries and thin samples return the locked "too few scores" string.
 */
export function formatScore(entry) {
  if (!entry || typeof entry !== 'object') return COPY.tooFewScores;

  const { avg, count } = entry;
  if (!isFiniteNumber(count) || count < MIN_SCORES) return COPY.tooFewScores;
  if (!isFiniteNumber(avg)) return COPY.tooFewScores;

  // + epsilon so a float like 4.199999999 does not fall to 4.1.
  const shown = (Math.floor(avg * 10 + 1e-9) / 10).toFixed(1);
  const noun = count === 1 ? 'score' : 'scores';

  return `${shown} · ${count} ${noun}`;
}

/**
 * Which visual state a marker or list row is in. Selection outranks hover,
 * hover outranks the resting state.
 */
export function markerState(placeId, { selectedId = null, hoveredId = null } = {}) {
  if (placeId && placeId === selectedId) return 'selected';
  if (placeId && placeId === hoveredId) return 'hovered';
  return 'default';
}

/**
 * Order places loudest first, unrated last. Ties keep their input order so the
 * list does not reshuffle under the reader when a score comes back.
 * ponytail: no sort control in the UI (section 17). Upgrade path is exposing
 * this as a dropdown once anyone asks for it.
 */
export function sortPlaces(places, scores = {}) {
  if (!Array.isArray(places)) return [];

  const rank = (place) => {
    const entry = place && scores ? scores[place.id] : null;
    if (!entry || !isFiniteNumber(entry.count) || entry.count < MIN_SCORES) return -1;
    return isFiniteNumber(entry.avg) ? entry.avg : -1;
  };

  // Array.prototype.sort is stable, so returning 0 preserves the original order.
  return [...places].sort((a, b) => rank(b) - rank(a));
}
