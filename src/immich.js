import { HttpError } from './errors.js';

const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREVIEW_TYPES = ['image/jpeg', 'image/png'];
const REQUEST_TIMEOUT_MS = 10_000;
const VERSION_TTL_MS = 60 * 60 * 1000;

export function isAssetId(value) {
  return typeof value === 'string' && ASSET_ID.test(value);
}

// Immich 3.2 moved search criteria into a `filter` object and deprecated the
// top-level fields. Older servers only understand the top-level fields.
export function supportsFilterSearch({ major, minor }) {
  return major > 3 || (major === 3 && minor >= 2);
}

export function buildRandomSearch({ useFilter, size, albumIds, favoritesOnly }) {
  if (useFilter) {
    const filter = { type: { eq: 'IMAGE' }, visibility: { eq: 'timeline' } };
    if (albumIds.length > 0) filter.albumIds = { any: albumIds };
    if (favoritesOnly) filter.isFavorite = { eq: true };
    return { size, filter };
  }

  const body = { size, type: 'IMAGE', visibility: 'timeline' };
  if (albumIds.length > 0) body.albumIds = albumIds;
  if (favoritesOnly) body.isFavorite = true;
  return body;
}

// Archived, hidden and locked photos are excluded by the visibility filter.
// Trashed and offline assets are dropped here in case the server returns them.
function isShowable(asset) {
  return asset.type === 'IMAGE' && !asset.isTrashed && !asset.isOffline;
}

export function createImmichClient({
  url = '',
  apiKey = '',
  albumIds = [],
  favoritesOnly = false,
  playlistSize = 200,
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const enabled = Boolean(url && apiKey);
  let cachedVersion = null;

  async function send(apiPath, init = {}) {
    try {
      return await fetchImpl(`${url}/api${apiPath}`, {
        ...init,
        headers: { accept: 'application/json', 'x-api-key': apiKey, ...init.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new HttpError(502, `Cannot reach Immich (${err.cause?.code ?? err.name}). Check IMMICH_URL.`);
    }
  }

  async function checked(res, what, notFoundMessage) {
    if (res.ok) return res;
    await res.arrayBuffer().catch(() => {});
    if (res.status === 401 || res.status === 403) {
      throw new HttpError(502, 'Immich rejected the API key. Check IMMICH_API_KEY and that it has asset.read and asset.view.');
    }
    if (res.status === 404 && notFoundMessage) throw new HttpError(404, notFoundMessage);
    throw new HttpError(502, `Immich returned HTTP ${res.status} for ${what}`);
  }

  async function readJson(res, what) {
    try {
      return await res.json();
    } catch {
      throw new HttpError(502, `Immich sent an unreadable reply for ${what}`);
    }
  }

  async function usesFilterSearch() {
    if (cachedVersion && Date.now() - cachedVersion.checkedAt < VERSION_TTL_MS) {
      return cachedVersion.useFilter;
    }
    const res = await checked(await send('/server/version'), 'the version check');
    const version = await readJson(res, 'the version check');
    cachedVersion = { useFilter: supportsFilterSearch(version), checkedAt: Date.now() };
    return cachedVersion.useFilter;
  }

  async function getPlaylist() {
    const body = buildRandomSearch({
      useFilter: await usesFilterSearch(),
      size: playlistSize,
      albumIds,
      favoritesOnly,
    });
    const res = await checked(
      await send('/search/random', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      'the photo search',
    );
    const assets = await readJson(res, 'the photo search');
    if (!Array.isArray(assets)) throw new HttpError(502, 'Immich sent an unexpected reply for the photo search');

    return assets.filter(isShowable).map((asset) => ({
      id: asset.id,
      takenAt: asset.localDateTime ?? asset.fileCreatedAt ?? null,
    }));
  }

  async function getPreview(assetId) {
    if (!isAssetId(assetId)) throw new HttpError(400, 'Invalid photo id');

    const res = await checked(
      await send(`/assets/${assetId}/thumbnail?size=preview`, { headers: { accept: 'image/jpeg, image/png' } }),
      'the photo',
      'Photo not found in Immich',
    );
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!PREVIEW_TYPES.includes(type)) {
      await res.arrayBuffer().catch(() => {});
      throw new HttpError(
        502,
        `Immich sent a ${type || 'untyped'} preview. The iPad (iOS 12) only shows JPEG or PNG, so set the Immich preview format to jpeg.`,
      );
    }
    return { type, body: Buffer.from(await res.arrayBuffer()) };
  }

  return { enabled, getPlaylist, getPreview };
}
