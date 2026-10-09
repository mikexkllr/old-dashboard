import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './errors.js';

const DEFAULT_PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const PHOTOS_OFF = 'Photos are off. Set IMMICH_URL and IMMICH_API_KEY on the server.';
const HOME_OFF = 'Home Assistant is off. Set HA_URL and HA_TOKEN on the server.';

export function createApp({ config, immich, homeAssistant, publicDir = DEFAULT_PUBLIC_DIR, logger = console }) {
  return createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      await route(req, res, pathname, { config, immich, homeAssistant, publicDir });
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message }, err.headers);
      } else {
        logger.error(err);
        sendJson(res, 500, { error: 'Something went wrong on the dashboard server' });
      }
    }
  });
}

async function route(req, res, pathname, { config, immich, homeAssistant, publicDir }) {
  if (pathname === '/api/health') {
    requireMethod(req, 'GET');
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/config') {
    requireMethod(req, 'GET');
    return sendJson(res, 200, {
      ...config.frame,
      photosEnabled: immich.enabled,
      homeAssistantEnabled: homeAssistant.enabled,
    });
  }

  if (pathname === '/api/photos') {
    requireMethod(req, 'GET');
    requireEnabled(immich.enabled, PHOTOS_OFF);
    return sendJson(res, 200, { photos: await immich.getPlaylist() });
  }

  const photo = /^\/api\/photos\/([^/]+)\/image$/.exec(pathname);
  if (photo) {
    requireMethod(req, 'GET');
    requireEnabled(immich.enabled, PHOTOS_OFF);
    const image = await immich.getPreview(decodeSegment(photo[1]));
    res.writeHead(200, {
      'content-type': image.type,
      'content-length': image.body.length,
      'cache-control': 'private, max-age=86400',
    });
    return res.end(image.body);
  }

  if (pathname === '/api/ha/entities') {
    requireMethod(req, 'GET');
    if (!homeAssistant.enabled) return sendJson(res, 200, { configured: false, entities: [] });
    return sendJson(res, 200, { configured: true, entities: await homeAssistant.getEntities() });
  }

  const action = /^\/api\/ha\/entities\/([^/]+)\/action$/.exec(pathname);
  if (action) {
    requireMethod(req, 'POST');
    requireEnabled(homeAssistant.enabled, HOME_OFF);
    const entity = await homeAssistant.runAction(decodeSegment(action[1]));
    return sendJson(res, 200, { entity });
  }

  if (pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');

  return serveStatic(req, res, pathname, publicDir);
}

async function serveStatic(req, res, pathname, publicDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new HttpError(405, 'Method not allowed', { Allow: 'GET, HEAD' });
  }

  const requested = pathname === '/' ? '/index.html' : decodeSegment(pathname);
  const filePath = path.resolve(publicDir, `.${requested}`);
  if (!filePath.startsWith(publicDir + path.sep)) throw new HttpError(404, 'Not found');

  let body;
  try {
    body = await readFile(filePath);
  } catch (err) {
    if (['ENOENT', 'EISDIR', 'ENOTDIR', 'ERR_INVALID_ARG_VALUE'].includes(err.code)) {
      throw new HttpError(404, 'Not found');
    }
    throw err;
  }

  res.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function requireMethod(req, method) {
  if (req.method !== method) throw new HttpError(405, 'Method not allowed', { Allow: method });
}

function requireEnabled(enabled, message) {
  if (!enabled) throw new HttpError(503, message);
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, 'Malformed URL');
  }
}
