// dreamworld-marble-proxy: Cloudflare Worker holding the World Labs API key.
// Endpoints (CORS-locked to the demo origin):
//   POST /generate  {prompt}                 -> {operation_id}
//   GET  /status/:operation_id               -> {done, world_id?, assets?, error?}
//   GET  /asset?url=<signed spz/pano url>    -> proxied bytes with CORS (splats etc.)
// MOCK MODE: when env.MOCK === "true", /generate returns a mock op that completes
// after ~15s with a public sample splat, so the full page flow is testable key-less.

const API = 'https://api.worldlabs.ai/marble/v1';

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function json(env, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(env) } });
}

// Mock world used when MOCK=true (public sample splat hosted by SparkJS demos)
const MOCK_SPZ = 'https://sparkjs.dev/assets/splats/butterfly.spz';
const mockStore = new Map(); // best-effort; isolate-local (mock only)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) });

    if (url.pathname === '/generate' && request.method === 'POST') {
      const { prompt } = await request.json().catch(() => ({}));
      if (!prompt || typeof prompt !== 'string' || prompt.length > 500) return json(env, { error: 'bad prompt' }, 400);

      if (env.MOCK === 'true' || !env.WLT_API_KEY) {
        const id = 'mock-' + crypto.randomUUID();
        mockStore.set(id, Date.now());
        return json(env, { operation_id: id, mock: true });
      }

      const r = await fetch(`${API}/worlds:generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'WLT-Api-Key': env.WLT_API_KEY },
        body: JSON.stringify({
          display_name: prompt.slice(0, 60),
          model: env.MARBLE_MODEL || 'marble-1.1',
          world_prompt: { type: 'text', text_prompt: prompt },
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return json(env, { error: data.error || ('worldlabs ' + r.status) }, r.status);
      return json(env, { operation_id: data.operation_id });
    }

    const m = url.pathname.match(/^\/status\/([A-Za-z0-9-]+)$/);
    if (m && request.method === 'GET') {
      const id = m[1];
      if (id.startsWith('mock-')) {
        const t0 = mockStore.get(id);
        if (!t0) return json(env, { done: false }); // isolate restarted; keep polling
        if (Date.now() - t0 < 15000) return json(env, { done: false, mock: true });
        return json(env, {
          done: true, mock: true, world_id: 'mock-world',
          assets: { splats: { spz_urls: { '500k': MOCK_SPZ } }, thumbnail_url: '', caption: 'mock world' },
          viewer_url: '',
        });
      }
      if (!env.WLT_API_KEY) return json(env, { error: 'no key configured' }, 503);
      const r = await fetch(`${API}/operations/${id}`, { headers: { 'WLT-Api-Key': env.WLT_API_KEY } });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) return json(env, { error: data.error || ('worldlabs ' + r.status) }, r.status);
      if (!data.done) return json(env, { done: false });
      const w = data.response || {};
      return json(env, {
        done: true,
        world_id: w.world_id,
        assets: w.assets,
        caption: w.assets && w.assets.caption,
        viewer_url: w.world_id ? `https://marble.worldlabs.ai/world/${w.world_id}` : '',
      });
    }

    if (url.pathname === '/asset' && request.method === 'GET') {
      const target = url.searchParams.get('url');
      const ok = target && /^(https:\/\/[^/]*(worldlabs|sparkjs)[^/]*\/)/.test(target);
      if (!ok) return json(env, { error: 'url not allowed' }, 403);
      const up = await fetch(target, { headers: request.headers.get('Range') ? { Range: request.headers.get('Range') } : {} });
      return new Response(up.body, {
        status: up.status,
        headers: { 'Content-Type': up.headers.get('Content-Type') || 'application/octet-stream', ...cors(env) },
      });
    }

    return json(env, { error: 'not found' }, 404);
  },
};
