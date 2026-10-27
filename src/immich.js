import { HttpError, unreachableError } from './errors.js';

const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREVIEW_TYPES = ['image/jpeg', 'image/png'];
const REQUEST_TIMEOUT_MS = 10_000;
const VERSION_TTL_MS = 60 * 60 * 1000;
const MAX_LEGACY_SEARCHES = 12;

export function isAssetId(value) {
  return typeof value === 'string' && ASSET_ID.test(value);
}

// Immich 3.2 moved search criteria into a `filter` object and deprecated the
// top-level fields. Older servers only understand the top-level fields.
export function supportsFilterSearch({ major, minor }) {
  return major > 3 || (major === 3 && minor >= 2);
}

// Years are whole calendar years, so a range from 2015 to 2020 covers
// 1 January 2015 up to the end of 31 December 2020.
function yearStart(year) {
  return `${year}-01-01T00:00:00.000Z`;
}

function yearEnd(year) {
  return `${year}-12-31T23:59:59.999Z`;
}

export function buildRandomSearch({
  useFilter,
  size,
  albumIds = [],
  personIds = [],
  favoritesOnly = false,
  fromYear = null,
  toYear = null,
}) {
  if (useFilter) {
    const filter = { type: { eq: 'IMAGE' }, visibility: { eq: 'timeline' } };
    if (albumIds.length > 0) filter.albumIds = { any: albumIds };
    if (personIds.length > 0) filter.personIds = { any: personIds };
    if (favoritesOnly) filter.isFavorite = { eq: true };
    if (fromYear !== null || toYear !== null) {
      filter.takenAt = {};
      if (fromYear !== null) filter.takenAt.gte = yearStart(fromYear);
      if (toYear !== null) filter.takenAt.lte = yearEnd(toYear);
    }
    return { size, filter };
  }

  const body = { size, type: 'IMAGE', visibility: 'timeline' };
  if (albumIds.length > 0) body.albumIds = albumIds;
  if (personIds.length > 0) body.personIds = personIds;
  if (favoritesOnly) body.isFavorite = true;
  if (fromYear !== null) body.takenAfter = yearStart(fromYear);
  if (toYear !== null) body.takenBefore = yearEnd(toYear);
  return body;
}

// Before Immich 3.2, a search for several albums only finds photos that are in
// every one of them, and the same goes for people. To show photos from any of
// them, older servers get one search per album and person instead. A long
// list is sampled, so each batch covers a different part of it.
export function legacySearches({ size, albumIds = [], personIds = [], ...rest }, maxSearches = MAX_LEGACY_SEARCHES) {
  const albums = albumIds.length > 0 ? albumIds.map((id) => [id]) : [[]];
  const people = personIds.length > 0 ? personIds.map((id) => [id]) : [[]];
  let pairs = [];
  for (const album of albums) {
    for (const person of people) pairs.push({ albumIds: album, personIds: person });
  }
  if (pairs.length > maxSearches) pairs = shuffle(pairs).slice(0, maxSearches);
  const each = Math.max(1, Math.ceil(size / pairs.length));
  return pairs.map((pair) => ({ ...rest, ...pair, size: each }));
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Archived, hidden and locked photos are excluded by the visibility filter.
// Trashed and offline assets are dropped here in case the server returns them.
function isShowable(asset) {
  return asset.type === 'IMAGE' && !asset.isTrashed && !asset.isOffline;
}

export function createImmichClient({
  url = '',
  apiKey = '',
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
      throw unreachableError('Immich', 'IMMICH_URL', url, err);
    }
  }

  async function checked(res, what, { notFound, forbidden } = {}) {
    if (res.ok) return res;
    await res.arrayBuffer().catch(() => {});
    if (res.status === 403 && forbidden) throw new HttpError(502, forbidden);
    if (res.status === 401 || res.status === 403) {
      throw new HttpError(502, 'Immich rejected the API key. Check IMMICH_API_KEY and that it has asset.read and asset.view.');
    }
    if (res.status === 404 && notFound) throw new HttpError(404, notFound);
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

  async function randomSearch(body) {
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
    return { assets, full: assets.length >= body.size };
  }

  /**
   * A random batch of photos that match the filters. `more` is true when
   * Immich had at least a full batch, so more photos match than were sent.
   */
  async function getPlaylist(filters = {}) {
    const useFilter = await usesFilterSearch();
    const albumIds = filters.albumIds ?? [];
    const personIds = filters.personIds ?? [];
    const criteria = { ...filters, albumIds, personIds, size: playlistSize };
    const searches = !useFilter && (albumIds.length > 1 || personIds.length > 1)
      ? legacySearches(criteria).map((search) => buildRandomSearch({ useFilter, ...search }))
      : [buildRandomSearch({ useFilter, ...criteria })];

    const results = await Promise.all(searches.map(randomSearch));
    const seen = new Set();
    const photos = [];
    for (const asset of shuffle(results.flatMap((result) => result.assets))) {
      if (!isShowable(asset) || seen.has(asset.id)) continue;
      seen.add(asset.id);
      photos.push({ id: asset.id, takenAt: asset.localDateTime ?? asset.fileCreatedAt ?? null });
    }
    return { photos, more: results.some((result) => result.full) };
  }

  // Before Immich 3.2, albums shared with you are only listed with ?shared=true.
  // Newer servers list every album at once and may refuse that parameter.
  async function listAlbums() {
    const forbidden = 'The Immich API key cannot list albums. Give it the album.read permission.';
    const read = async (query) => {
      const res = await checked(await send(`/albums${query}`), 'the album list', { forbidden });
      const albums = await readJson(res, 'the album list');
      if (!Array.isArray(albums)) throw new HttpError(502, 'Immich sent an unexpected album list');
      return albums;
    };
    const owned = await read('');
    const shared = await read('?shared=true').catch(() => []);

    const byId = new Map();
    for (const album of [...owned, ...shared]) {
      if (!isAssetId(album?.id) || byId.has(album.id)) continue;
      byId.set(album.id, {
        id: album.id,
        name: typeof album.albumName === 'string' && album.albumName.trim() ? album.albumName.trim() : 'Untitled album',
        count: typeof album.assetCount === 'number' ? album.assetCount : null,
        shared: album.shared === true,
      });
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // Only people with a name are listed. Immich finds many faces nobody named.
  async function listPeople() {
    const res = await checked(
      await send('/people?withHidden=false&size=1000'),
      'the list of people',
      { forbidden: 'The Immich API key cannot list people. Give it the person.read permission.' },
    );
    const body = await readJson(res, 'the list of people');
    const people = Array.isArray(body) ? body : body?.people;
    if (!Array.isArray(people)) throw new HttpError(502, 'Immich sent an unexpected list of people');
    return people
      .filter((person) => isAssetId(person?.id) && !person.isHidden && typeof person.name === 'string' && person.name.trim())
      .map((person) => ({ id: person.id, name: person.name.trim() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function getPreview(assetId) {
    if (!isAssetId(assetId)) throw new HttpError(400, 'Invalid photo id');

    const res = await checked(
      await send(`/assets/${assetId}/thumbnail?size=preview`, { headers: { accept: 'image/jpeg, image/png' } }),
      'the photo',
      { notFound: 'Photo not found in Immich' },
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

  return { enabled, getPlaylist, getPreview, listAlbums, listPeople };
}
