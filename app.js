// app.js — everything impure: DOM, Leaflet, localStorage, network.
// All decision logic lives in map-logic.js so the test suite can reach it.

import {
  COPY,
  PRICES,
  boundsOf,
  emptyFilters,
  filterPlaces,
  formatScore,
  markerState,
  parseFilters,
  serializeFilters,
  sortPlaces
} from './map-logic.js';

/* ------------------------------------------------------------------ config */

// Site keys are public. Secrets live in `wrangler secret`, never here.
const CONFIG = {
  WORKER_URL: 'https://squeak-easy.example.workers.dev',
  TURNSTILE_SITE_KEY: ''
};

const STORAGE = {
  welcomeSeen: 'squeakeasy.welcome.seen',
  rated: 'squeakeasy.rated'
};

const COPY_LOCAL = {
  ratePrompt: 'How loud was the squeak?',
  scoreLabels: ['Silent', 'Faint', 'Respectable', 'Loud', 'Heard it in the parking lot'],
  submit: 'Log the squeak',
  submitSuccess: 'Squeak logged. Thanks for your service.',
  alreadyRated: 'You already rated this one. One squeak per place per day.',
  rateLimited: 'Easy there. Come back in a bit.'
};

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------- state */

const state = {
  places: [],
  scores: {},
  scoresFailed: false,
  filters: emptyFilters(),
  visible: [],
  selectedId: null,
  hoveredId: null
};

const markers = new Map();   // placeId -> L.Marker
const listRows = new Map();  // placeId -> HTMLButtonElement

const el = {
  form: document.getElementById('filters'),
  q: document.getElementById('filter-q'),
  price: document.getElementById('filter-price'),
  county: document.getElementById('filter-county'),
  list: document.getElementById('place-list'),
  count: document.getElementById('result-count'),
  empty: document.getElementById('empty-state'),
  welcome: document.getElementById('welcome'),
  welcomeDismiss: document.getElementById('welcome-dismiss'),
  openWelcome: document.getElementById('open-welcome')
};

/* ------------------------------------------------------------- local store */

function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode, quota, whatever. Not worth breaking the page over. */
  }
}

const today = () => new Date().toISOString().slice(0, 10);

// A courtesy so the UI can answer instantly. The Worker is the real control.
function ratedToday(placeId) {
  const rated = readStore(STORAGE.rated, {});
  return rated && rated[placeId] === today();
}

function markRated(placeId) {
  const rated = readStore(STORAGE.rated, {}) || {};
  rated[placeId] = today();
  writeStore(STORAGE.rated, rated);
}

/* ----------------------------------------------------------------- helpers */

function scoreText(placeId) {
  if (state.scoresFailed) return COPY.offline;
  return formatScore(state.scores[placeId]);
}

function directionsUrl(place) {
  return `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.appendChild(use);
  return svg;
}

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

/* --------------------------------------------------------------------- map */

// Section 13: if Leaflet or its tiles never arrive, the list still shows every
// place. Everything map-shaped below is a no-op when hasMap is false.
const hasMap = typeof window.L !== 'undefined';
let map = null;

if (hasMap) {
  map = L.map('map', {
    zoomControl: true,
    scrollWheelZoom: true,
    fadeAnimation: !reduceMotion,
    zoomAnimation: !reduceMotion,
    markerZoomAnimation: !reduceMotion
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19
  }).addTo(map);
} else {
  document.getElementById('map').hidden = true;
}

function buildIcon(placeId) {
  const stateName = markerState(placeId, state);
  if (!hasMap) return null;
  const size = stateName === 'default' ? 28 : 34;
  return L.divIcon({
    className: '',
    html: `<span class="squeak-marker" data-state="${stateName}"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2]
  });
}

function refreshMarker(placeId) {
  const marker = markers.get(placeId);
  if (hasMap && marker) marker.setIcon(buildIcon(placeId));

  const row = listRows.get(placeId);
  if (row) row.dataset.state = markerState(placeId, state);
}

function refreshAllStates() {
  for (const id of markers.keys()) refreshMarker(id);
  for (const id of listRows.keys()) refreshMarker(id);
}

function fitToVisible() {
  if (!hasMap) return;
  const { south, west, north, east } = boundsOf(state.visible);
  map.fitBounds(
    [[south, west], [north, east]],
    { padding: [32, 32], maxZoom: 14, animate: !reduceMotion }
  );
}

/* ------------------------------------------------------------------- popup */

function buildPopup(place) {
  const wrap = node('div', 'popup');

  wrap.appendChild(node('h3', 'popup-name', place.name));
  wrap.appendChild(node('p', 'popup-address', place.address));
  wrap.appendChild(node('p', 'popup-order', place.order));
  if (place.note) wrap.appendChild(node('p', 'popup-note', place.note));

  const score = node('p', 'popup-score');
  score.dataset.scoreFor = place.id;
  score.textContent = `${place.price} · ${scoreText(place.id)}`;
  wrap.appendChild(score);

  const links = node('div', 'popup-links');

  const dir = node('a');
  dir.href = directionsUrl(place);
  dir.target = '_blank';
  dir.rel = 'noopener';
  dir.appendChild(icon('directions'));
  dir.appendChild(document.createTextNode('Directions'));
  links.appendChild(dir);

  if (place.url) {
    const site = node('a', null, 'Website');
    site.href = place.url;
    site.target = '_blank';
    site.rel = 'noopener';
    links.appendChild(site);
  }
  wrap.appendChild(links);

  wrap.appendChild(buildRatingControl(place));
  return wrap;
}

function buildRatingControl(place) {
  const fieldset = node('fieldset', 'rate');
  const legend = node('legend', 'rate-prompt', COPY_LOCAL.ratePrompt);
  fieldset.appendChild(legend);

  const options = node('div', 'rate-options');
  options.setAttribute('role', 'radiogroup');
  options.setAttribute('aria-label', COPY_LOCAL.ratePrompt);

  COPY_LOCAL.scoreLabels.forEach((label, index) => {
    const value = index + 1;
    const id = `rate-${place.id}-${value}`;

    const wrap = node('label', 'rate-option');
    wrap.htmlFor = id;

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = `rate-${place.id}`;
    input.id = id;
    input.value = String(value);

    wrap.appendChild(input);
    wrap.appendChild(document.createTextNode(`${value} · ${label}`));
    options.appendChild(wrap);
  });
  fieldset.appendChild(options);

  const submit = node('button', 'rate-submit', COPY_LOCAL.submit);
  submit.type = 'button';
  fieldset.appendChild(submit);

  const message = node('p', 'rate-message');
  message.setAttribute('role', 'status');
  fieldset.appendChild(message);

  if (ratedToday(place.id)) {
    submit.disabled = true;
    message.textContent = COPY_LOCAL.alreadyRated;
  }

  submit.addEventListener('click', async () => {
    const chosen = options.querySelector('input:checked');
    if (!chosen) {
      message.textContent = COPY_LOCAL.ratePrompt;
      return;
    }

    submit.disabled = true;
    const result = await submitScore(place.id, Number(chosen.value));

    message.textContent = result.message;
    if (result.ok) {
      markRated(place.id);
      updateScoreDisplay(place);
    } else if (result.retry) {
      submit.disabled = false;
    }
  });

  return fieldset;
}

function updateScoreDisplay(place) {
  const target = document.querySelector(`[data-score-for="${CSS.escape(place.id)}"]`);
  if (target) target.textContent = `${place.price} · ${scoreText(place.id)}`;

  const row = listRows.get(place.id);
  if (row) {
    const meta = row.querySelector('.place-meta');
    if (meta) meta.textContent = `${place.city} · ${place.price} · ${scoreText(place.id)}`;
  }
}

/* ---------------------------------------------------------------- network */

/*
  Turnstile in invisible mode, injected on demand so first paint has no
  third-party script. Resolves to an empty token when no site key is set, which
  lets the page run locally — the Worker still rejects the submit.
  ponytail: one widget rendered per page, reset between submits.
*/
let turnstileReady = null;
let turnstileWidget = null;

function loadTurnstile() {
  if (!CONFIG.TURNSTILE_SITE_KEY) return Promise.resolve(null);
  if (turnstileReady) return turnstileReady;

  turnstileReady = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => resolve(window.turnstile || null);
    script.onerror = () => reject(new Error('turnstile failed to load'));
    document.head.appendChild(script);
  });
  return turnstileReady;
}

async function getTurnstileToken() {
  const turnstile = await loadTurnstile().catch(() => null);
  if (!turnstile) return '';

  if (turnstileWidget === null) {
    const host = document.createElement('div');
    host.style.display = 'none';
    document.body.appendChild(host);
    turnstileWidget = turnstile.render(host, {
      sitekey: CONFIG.TURNSTILE_SITE_KEY,
      size: 'invisible'
    });
  } else {
    turnstile.reset(turnstileWidget);
  }

  return turnstile.execute(turnstileWidget, { async: true }).catch(() => '');
}

async function loadScores() {
  try {
    const response = await fetch(`${CONFIG.WORKER_URL}/scores`, { mode: 'cors' });
    if (!response.ok) throw new Error(`scores ${response.status}`);
    state.scores = await response.json();
    state.scoresFailed = false;
  } catch {
    // Section 10: the map, list, and filters all keep working.
    state.scores = {};
    state.scoresFailed = true;
  }
}

async function submitScore(placeId, score) {
  if (ratedToday(placeId)) {
    return { ok: false, retry: false, message: COPY_LOCAL.alreadyRated };
  }

  try {
    const turnstileToken = await getTurnstileToken();
    const response = await fetch(`${CONFIG.WORKER_URL}/scores`, {
      method: 'POST',
      mode: 'cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ placeId, score, turnstileToken })
    });

    if (response.status === 409) {
      markRated(placeId);
      return { ok: false, retry: false, message: COPY_LOCAL.alreadyRated };
    }
    if (response.status === 429) {
      return { ok: false, retry: false, message: COPY_LOCAL.rateLimited };
    }
    if (!response.ok) throw new Error(`submit ${response.status}`);

    const body = await response.json();
    state.scores[placeId] = { avg: body.avg, count: body.count };
    state.scoresFailed = false;

    return { ok: true, retry: false, message: COPY_LOCAL.submitSuccess };
  } catch {
    return { ok: false, retry: true, message: COPY.offline };
  }
}

/* -------------------------------------------------------------- rendering */

function selectPlace(placeId, { fromMap = false } = {}) {
  state.selectedId = placeId;
  refreshAllStates();

  const place = state.places.find((p) => p.id === placeId);
  const marker = markers.get(placeId);

  if (hasMap && !fromMap && place && marker) {
    map.panTo([place.lat, place.lng], { animate: !reduceMotion });
    marker.openPopup();
  }

  const row = listRows.get(placeId);
  if (row) {
    row.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
  }
}

function setHovered(placeId) {
  if (state.hoveredId === placeId) return;
  const previous = state.hoveredId;
  state.hoveredId = placeId;
  if (previous) refreshMarker(previous);
  if (placeId) refreshMarker(placeId);
}

function buildListRow(place) {
  const li = node('li', 'place-item');

  const button = node('button', 'place-button');
  button.type = 'button';
  button.dataset.placeId = place.id;
  button.dataset.state = markerState(place.id, state);

  button.appendChild(node('span', 'place-name', place.name));
  button.appendChild(node('span', 'place-meta', `${place.city} · ${place.price} · ${scoreText(place.id)}`));
  button.appendChild(node('span', 'place-order', place.order));

  button.addEventListener('click', () => selectPlace(place.id));
  button.addEventListener('mouseenter', () => setHovered(place.id));
  button.addEventListener('mouseleave', () => setHovered(null));
  button.addEventListener('focus', () => setHovered(place.id));
  button.addEventListener('blur', () => setHovered(null));

  li.appendChild(button);
  listRows.set(place.id, button);
  return li;
}

function render() {
  state.visible = sortPlaces(filterPlaces(state.places, state.filters), state.scores);
  const visibleIds = new Set(state.visible.map((p) => p.id));

  // list
  listRows.clear();
  el.list.replaceChildren(...state.visible.map(buildListRow));

  el.count.textContent = `${state.visible.length} of ${state.places.length} places`;
  el.empty.hidden = state.visible.length !== 0;

  // markers
  for (const [id, marker] of markers) {
    const onMap = map.hasLayer(marker);  // markers map is empty when hasMap is false
    if (visibleIds.has(id) && !onMap) marker.addTo(map);
    if (!visibleIds.has(id) && onMap) map.removeLayer(marker);
  }

  if (state.selectedId && !visibleIds.has(state.selectedId)) state.selectedId = null;

  refreshAllStates();
  if (state.visible.length > 0) fitToVisible();
}

function buildMarkers() {
  if (!hasMap) return;
  for (const place of state.places) {
    const marker = L.marker([place.lat, place.lng], {
      icon: buildIcon(place.id),
      keyboard: true,
      title: place.name,
      alt: place.name
    });

    marker.bindPopup(() => buildPopup(place), { minWidth: 250, autoPan: !reduceMotion });
    marker.on('click', () => selectPlace(place.id, { fromMap: true }));
    marker.on('mouseover', () => setHovered(place.id));
    marker.on('mouseout', () => setHovered(null));

    markers.set(place.id, marker);
  }
}

/* ---------------------------------------------------------------- filters */

function readFiltersFromForm() {
  const price = el.price.querySelector('input:checked');
  return {
    q: el.q.value.trim(),
    price: price && PRICES.includes(price.value) ? price.value : '',
    county: el.county.value
  };
}

function writeFiltersToForm(filters) {
  el.q.value = filters.q;
  el.county.value = filters.county;

  const target = [...el.price.querySelectorAll('input')]
    .find((input) => input.value === filters.price);
  if (target) target.checked = true;
  else el.price.querySelector('input[value=""]').checked = true;

  // A county that is not in the list (stale URL) falls back to all counties.
  if (el.county.value !== filters.county) el.county.value = '';
}

function syncUrl() {
  const query = serializeFilters(state.filters);
  // Keep the path and any fragment — only the query belongs to the filters.
  const url = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
  window.history.replaceState(null, '', url);
}

function onFilterChange() {
  state.filters = readFiltersFromForm();
  syncUrl();
  render();
}

function populateCounties() {
  const counties = [...new Set(state.places.map((p) => p.county).filter(Boolean))].sort();
  for (const county of counties) {
    const option = node('option', null, county);
    option.value = county;
    el.county.appendChild(option);
  }
}

/* ---------------------------------------------------------------- welcome */

function openWelcome() {
  if (el.welcome.open) return;
  el.welcome.showModal();
  el.welcomeDismiss.focus();
}

// Every dismissal path lands here: the button, Escape, and the backdrop.
// The dialog "close" event is not a reliable hook (it does not fire in every
// engine when close() is called from script), so the side effects live in the
// function rather than in a listener.
function closeWelcome() {
  if (!el.welcome.open) return;
  el.welcome.close();
  writeStore(STORAGE.welcomeSeen, true);
  el.q.focus();
}

el.welcomeDismiss.addEventListener('click', closeWelcome);
el.openWelcome.addEventListener('click', openWelcome);

// Backdrop click. The dialog element itself is the backdrop hit area.
el.welcome.addEventListener('click', (event) => {
  if (event.target === el.welcome) closeWelcome();
});

// Escape. Take it over so it runs the same path as the button.
el.welcome.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeWelcome();
});

/* ------------------------------------------------------------------- boot */

async function boot() {
  el.form.addEventListener('input', onFilterChange);
  el.form.addEventListener('change', onFilterChange);
  el.form.addEventListener('submit', (event) => event.preventDefault());

  try {
    const response = await fetch('places.json');
    state.places = await response.json();
  } catch {
    state.places = [];
    el.count.textContent = '0 of 0 places';
    el.empty.hidden = false;
    return;
  }

  populateCounties();

  state.filters = parseFilters(window.location.search);
  writeFiltersToForm(state.filters);
  state.filters = readFiltersFromForm();
  syncUrl();

  buildMarkers();
  render();

  // Scores are a progressive enhancement — the page is already usable.
  await loadScores();
  render();

  if (!readStore(STORAGE.welcomeSeen, false)) openWelcome();
}

boot();
