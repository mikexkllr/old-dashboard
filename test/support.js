import { createServer } from 'node:http';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createHomeAssistantClient } from '../src/homeassistant.js';
import { createImmichClient } from '../src/immich.js';

export const IMMICH_KEY = 'immich-test-key';
export const HA_TOKEN = 'ha-test-token';

// Not a real picture, just JPEG magic bytes. The server passes bytes through
// without decoding them, so this is enough to check the proxy.
export const PREVIEW_JPEG = Buffer.from('ffd8ffe000104a464946000102', 'hex');

export const ASSET_IMAGE = '11111111-1111-4111-8111-111111111111';
export const ASSET_VIDEO = '22222222-2222-4222-8222-222222222222';
export const ASSET_TRASHED = '33333333-3333-4333-8333-333333333333';
export const ASSET_MISSING = '44444444-4444-4444-8444-444444444444';
export const ALBUM_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

export function defaultAssets() {
  return [
    {
      id: ASSET_IMAGE,
      type: 'IMAGE',
      visibility: 'timeline',
      isTrashed: false,
      isOffline: false,
      localDateTime: '2024-03-12T14:21:30.000Z',
      fileCreatedAt: '2024-03-12T13:21:30.000Z',
    },
    {
      id: ASSET_VIDEO,
      type: 'VIDEO',
      visibility: 'timeline',
      isTrashed: false,
      isOffline: false,
      localDateTime: '2024-03-13T10:00:00.000Z',
      fileCreatedAt: '2024-03-13T10:00:00.000Z',
    },
    {
      id: ASSET_TRASHED,
      type: 'IMAGE',
      visibility: 'timeline',
      isTrashed: true,
      isOffline: false,
      localDateTime: '2024-03-14T10:00:00.000Z',
      fileCreatedAt: '2024-03-14T10:00:00.000Z',
    },
  ];
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

export function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
}

/** A stand-in for Immich. Records every request so tests can check what the dashboard sent. */
export async function startImmich({
  version = { major: 3, minor: 3, patch: 0 },
  assets = defaultAssets(),
  previewType = 'image/jpeg',
} = {}) {
  const calls = [];
  const mock = await listen(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const body = req.method === 'POST' ? await readBody(req) : '';
    calls.push({ method: req.method, path: url.pathname + url.search, headers: req.headers, body });

    if (url.pathname === '/api/server/version') return json(res, 200, version);
    if (req.headers['x-api-key'] !== IMMICH_KEY) return json(res, 401, { message: 'Invalid API key' });

    if (req.method === 'POST' && url.pathname === '/api/search/random') return json(res, 200, assets);

    const thumbnail = /^\/api\/assets\/([^/]+)\/thumbnail$/.exec(url.pathname);
    if (req.method === 'GET' && thumbnail) {
      if (!assets.some((asset) => asset.id === thumbnail[1])) return json(res, 404, { message: 'Not found' });
      res.writeHead(200, { 'content-type': previewType, 'content-length': PREVIEW_JPEG.length });
      return res.end(PREVIEW_JPEG);
    }

    return json(res, 404, { message: 'Unknown route' });
  });
  return { ...mock, calls, close: () => closeServer(mock.server) };
}

/** A stand-in for Home Assistant. Flips on/off for toggle services, like a real device would. */
export async function startHomeAssistant(states) {
  const calls = [];
  const current = structuredClone(states);
  const mock = await listen(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const body = await readBody(req);
    calls.push({ method: req.method, path: url.pathname, body, authorization: req.headers.authorization });

    if (req.headers.authorization !== `Bearer ${HA_TOKEN}`) {
      return json(res, 401, { message: 'Invalid access token or password' });
    }

    const state = /^\/api\/states\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && state) {
      return current[state[1]] ? json(res, 200, current[state[1]]) : json(res, 404, { message: 'Entity not found.' });
    }

    const service = /^\/api\/services\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'POST' && service) {
      const { entity_id: entityId } = JSON.parse(body || '{}');
      if (!current[entityId]) return json(res, 400, { message: 'Unknown entity' });
      if (service[2] === 'toggle') {
        current[entityId].state = current[entityId].state === 'on' ? 'off' : 'on';
      }
      return json(res, 200, []);
    }

    return json(res, 404, { message: 'Unknown route' });
  });
  return { ...mock, calls, states: current, close: () => closeServer(mock.server) };
}

/** Starts the dashboard against whatever upstreams the env points at. */
export async function startDashboard(env) {
  const config = loadConfig(env);
  const immich = createImmichClient(config.immich);
  const homeAssistant = createHomeAssistantClient(config.homeAssistant);
  const server = createApp({ config, immich, homeAssistant, logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => closeServer(server) };
}
