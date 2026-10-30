// worker.js — the scores backend. GET /scores reads, POST /scores writes.
// Deployed by Cloudflare Workers Builds on push to main (`npx wrangler deploy`).

const PLACE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const AGG_KEY = 'agg';
const PER_IP_PER_HOUR = 15;

const json = (body, status, origin) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) }
  });

function cors(origin) {
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

// Only the live site and local dev may call this. Anything else gets no CORS headers.
function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const allowed = [env.ALLOWED_ORIGIN, 'http://localhost:8080', 'http://127.0.0.1:8080'].filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

// Raw IPs never hit storage — only a truncated hash of them.
async function ipKey(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  return [...new Uint8Array(digest)].slice(0, 10).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function turnstileOk(token, request, env) {
  if (!env.TURNSTILE_SECRET) return true; // not configured yet; KV limits carry the load
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET);
  body.append('response', token || '');
  body.append('remoteip', request.headers.get('CF-Connecting-IP') || '');
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    return (await res.json()).success === true;
  } catch {
    return false;
  }
}

const averages = (agg) =>
  Object.fromEntries(
    Object.entries(agg).map(([id, { sum, count }]) => [id, { avg: Math.round((sum / count) * 10) / 10, count }])
  );

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (pathname !== '/scores') return json({ error: 'not found' }, 404, origin);

    const agg = (await env.SCORES.get(AGG_KEY, 'json')) || {};

    if (request.method === 'GET') return json(averages(agg), 200, origin);
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, origin);
    if (!origin) return json({ error: 'forbidden' }, 403, null);

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: 'bad json' }, 400, origin);
    }

    const { placeId, score, turnstileToken } = payload || {};
    if (typeof placeId !== 'string' || !PLACE_ID.test(placeId)) return json({ error: 'bad placeId' }, 400, origin);
    if (!Number.isInteger(score) || score < 1 || score > 5) return json({ error: 'bad score' }, 400, origin);
    if (!(await turnstileOk(turnstileToken, request, env))) return json({ error: 'challenge failed' }, 403, origin);

    const ip = await ipKey(request);
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const hour = now.toISOString().slice(0, 13);

    const oncePerDay = `d:${day}:${ip}:${placeId}`;
    if (await env.SCORES.get(oncePerDay)) return json({ error: 'already rated' }, 409, origin);

    const burst = `h:${hour}:${ip}`;
    const used = Number((await env.SCORES.get(burst)) || 0);
    if (used >= PER_IP_PER_HOUR) return json({ error: 'rate limited' }, 429, origin);

    // ponytail: whole aggregate in one KV key, so two submissions landing in the
    // same instant can drop one vote. Upgrade to a Durable Object if traffic warrants.
    const current = agg[placeId] || { sum: 0, count: 0 };
    const next = { sum: current.sum + score, count: current.count + 1 };
    agg[placeId] = next;

    await Promise.all([
      env.SCORES.put(AGG_KEY, JSON.stringify(agg)),
      env.SCORES.put(oncePerDay, '1', { expirationTtl: 86400 }),
      env.SCORES.put(burst, String(used + 1), { expirationTtl: 3600 })
    ]);

    return json({ avg: Math.round((next.sum / next.count) * 10) / 10, count: next.count }, 200, origin);
  }
};
