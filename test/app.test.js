import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildRandomSearch, legacySearches, supportsFilterSearch } from '../src/immich.js';
import {
  ALBUM_ID,
  ALBUM_SHARED,
  ASSET_IMAGE,
  ASSET_MISSING,
  defaultAssets,
  HA_TOKEN,
  IMMICH_KEY,
  PERSON_ANNA,
  PERSON_BEN,
  PREVIEW_JPEG,
  startDashboard,
  startHomeAssistant,
  startImmich,
} from './support.js';

const post = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('filter-style search is used from Immich 3.2 onwards only', () => {
  assert.equal(supportsFilterSearch({ major: 2, minor: 9 }), false);
  assert.equal(supportsFilterSearch({ major: 3, minor: 1 }), false);
  assert.equal(supportsFilterSearch({ major: 3, minor: 2 }), true);
  assert.equal(supportsFilterSearch({ major: 4, minor: 0 }), true);
});

test('builds year ranges from the start of the first year to the end of the last', () => {
  assert.deepEqual(buildRandomSearch({ useFilter: true, size: 10, toYear: 2019 }).filter.takenAt, {
    lte: '2019-12-31T23:59:59.999Z',
  });
  const legacy = buildRandomSearch({ useFilter: false, size: 10, fromYear: 2015, toYear: 2015, personIds: [PERSON_ANNA] });
  assert.equal(legacy.takenAfter, '2015-01-01T00:00:00.000Z');
  assert.equal(legacy.takenBefore, '2015-12-31T23:59:59.999Z');
  assert.deepEqual(legacy.personIds, [PERSON_ANNA]);
});

test('older servers get one search per album and person, sampled when there are many', () => {
  const searches = legacySearches({ size: 100, albumIds: [ALBUM_ID, ALBUM_SHARED], personIds: [PERSON_ANNA], favoritesOnly: true });
  assert.deepEqual(searches, [
    { favoritesOnly: true, albumIds: [ALBUM_ID], personIds: [PERSON_ANNA], size: 50 },
    { favoritesOnly: true, albumIds: [ALBUM_SHARED], personIds: [PERSON_ANNA], size: 50 },
  ]);
  const many = Array.from({ length: 30 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const sampled = legacySearches({ size: 200, albumIds: many, personIds: [] });
  assert.equal(sampled.length, 12);
  assert.equal(new Set(sampled.map((search) => search.albumIds[0])).size, 12);
  assert.ok(sampled.every((search) => search.size === 17 && search.personIds.length === 0));
});

describe('photos from Immich', () => {
  let immich;
  let dashboard;

  before(async () => {
    immich = await startImmich();
    dashboard = await startDashboard({
      IMMICH_URL: immich.url,
      IMMICH_API_KEY: IMMICH_KEY,
      IMMICH_PLAYLIST_SIZE: '50',
    });
  });

  after(async () => {
    await dashboard.close();
    await immich.close();
  });

  test('lists only timeline photos, sent as a filter search for Immich 3.3', async () => {
    const res = await fetch(`${dashboard.url}/api/photos`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const { photos, more } = await res.json();
    assert.deepEqual(photos, [{ id: ASSET_IMAGE, takenAt: '2024-03-12T14:21:30.000Z' }]);
    assert.equal(more, false, 'Immich sent fewer than a full batch, so these are all the matches');

    const search = immich.calls.find((call) => call.path === '/api/search/random');
    assert.equal(search.headers['x-api-key'], IMMICH_KEY);
    assert.deepEqual(JSON.parse(search.body), {
      size: 50,
      filter: { type: { eq: 'IMAGE' }, visibility: { eq: 'timeline' } },
    });
  });

  test('streams the preview through the dashboard so the key never reaches the iPad', async () => {
    const res = await fetch(`${dashboard.url}/api/photos/${ASSET_IMAGE}/image`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(res.headers.get('cache-control'), 'private, max-age=86400');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PREVIEW_JPEG);

    const thumbnail = immich.calls.findLast((call) => call.path.startsWith(`/api/assets/${ASSET_IMAGE}`));
    assert.equal(thumbnail.path, `/api/assets/${ASSET_IMAGE}/thumbnail?size=preview`);
    assert.equal(thumbnail.headers['x-api-key'], IMMICH_KEY);
  });

  test('asks for the Immich version once, not on every request', async () => {
    await fetch(`${dashboard.url}/api/photos`);
    await fetch(`${dashboard.url}/api/photos`);
    assert.equal(immich.calls.filter((call) => call.path === '/api/server/version').length, 1);
  });

  test('refuses malformed photo ids before calling Immich', async () => {
    const callsBefore = immich.calls.length;
    const res = await fetch(`${dashboard.url}/api/photos/..%2F..%2Fserver%2Fversion/image`);
    assert.equal(res.status, 400);
    assert.equal(immich.calls.length, callsBefore);
  });

  test('reports a photo that Immich no longer has as 404', async () => {
    const res = await fetch(`${dashboard.url}/api/photos/${ASSET_MISSING}/image`);
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /not found/i);
  });
});

describe('album and favourite filters', () => {
  test('older Immich servers get the top-level search fields', async () => {
    const immich = await startImmich({ version: { major: 2, minor: 5, patch: 0 } });
    const dashboard = await startDashboard({
      IMMICH_URL: immich.url,
      IMMICH_API_KEY: IMMICH_KEY,
      IMMICH_ALBUM_IDS: ALBUM_ID,
      IMMICH_FAVORITES_ONLY: 'true',
    });
    try {
      const res = await fetch(`${dashboard.url}/api/photos`);
      assert.equal(res.status, 200);
      const search = immich.calls.find((call) => call.path === '/api/search/random');
      assert.deepEqual(JSON.parse(search.body), {
        size: 200,
        type: 'IMAGE',
        visibility: 'timeline',
        albumIds: [ALBUM_ID],
        isFavorite: true,
      });
    } finally {
      await dashboard.close();
      await immich.close();
    }
  });

  test('Immich 3.2+ gets album and favourite filters inside the filter object', async () => {
    const immich = await startImmich({ version: { major: 3, minor: 2, patch: 0 } });
    const dashboard = await startDashboard({
      IMMICH_URL: immich.url,
      IMMICH_API_KEY: IMMICH_KEY,
      IMMICH_ALBUM_IDS: ALBUM_ID,
      IMMICH_FAVORITES_ONLY: 'true',
    });
    try {
      await fetch(`${dashboard.url}/api/photos`);
      const search = immich.calls.find((call) => call.path === '/api/search/random');
      assert.deepEqual(JSON.parse(search.body), {
        size: 200,
        filter: {
          type: { eq: 'IMAGE' },
          visibility: { eq: 'timeline' },
          albumIds: { any: [ALBUM_ID] },
          isFavorite: { eq: true },
        },
      });
    } finally {
      await dashboard.close();
      await immich.close();
    }
  });
});

describe('photo filters from the settings menu', () => {
  const put = (url, body) => fetch(`${url}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  test('Immich 3.2+ gets years, albums and people in one filter search, matching any album or person', async () => {
    const immich = await startImmich();
    const dashboard = await startDashboard({ IMMICH_URL: immich.url, IMMICH_API_KEY: IMMICH_KEY, IMMICH_TO_YEAR: '2020' });
    try {
      await put(dashboard.url, { fromYear: 2015, albumIds: [ALBUM_ID, ALBUM_SHARED], personIds: [PERSON_ANNA, PERSON_BEN] });
      assert.equal((await fetch(`${dashboard.url}/api/photos`)).status, 200);
      const searches = immich.calls.filter((call) => call.path === '/api/search/random');
      assert.equal(searches.length, 1);
      assert.deepEqual(JSON.parse(searches[0].body), {
        size: 200,
        filter: {
          type: { eq: 'IMAGE' },
          visibility: { eq: 'timeline' },
          albumIds: { any: [ALBUM_ID, ALBUM_SHARED] },
          personIds: { any: [PERSON_ANNA, PERSON_BEN] },
          takenAt: { gte: '2015-01-01T00:00:00.000Z', lte: '2020-12-31T23:59:59.999Z' },
        },
      });
    } finally {
      await dashboard.close();
      await immich.close();
    }
  });

  test('older Immich servers get one search per album, because they match every listed album at once', async () => {
    const immich = await startImmich({ version: { major: 2, minor: 5, patch: 0 } });
    const dashboard = await startDashboard({ IMMICH_URL: immich.url, IMMICH_API_KEY: IMMICH_KEY, IMMICH_PLAYLIST_SIZE: '100' });
    try {
      await put(dashboard.url, { albumIds: [ALBUM_ID, ALBUM_SHARED], fromYear: 2015 });
      const { photos } = await (await fetch(`${dashboard.url}/api/photos`)).json();
      assert.deepEqual(photos.map((photo) => photo.id), [ASSET_IMAGE], 'the same photo from two searches is shown once');

      const bodies = immich.calls
        .filter((call) => call.path === '/api/search/random')
        .map((call) => JSON.parse(call.body));
      assert.deepEqual(bodies.map((body) => body.albumIds).sort(), [[ALBUM_ID], [ALBUM_SHARED]].sort());
      for (const body of bodies) {
        assert.equal(body.size, 50);
        assert.equal(body.takenAfter, '2015-01-01T00:00:00.000Z');
        assert.equal(body.takenBefore, undefined);
      }
    } finally {
      await dashboard.close();
      await immich.close();
    }
  });

  test('says when more photos match than one batch holds', async () => {
    const assets = Array.from({ length: 5 }, (_, i) => ({
      ...defaultAssets()[0],
      id: `11111111-1111-4111-8111-11111111111${i}`,
    }));
    const immich = await startImmich({ assets });
    const dashboard = await startDashboard({ IMMICH_URL: immich.url, IMMICH_API_KEY: IMMICH_KEY, IMMICH_PLAYLIST_SIZE: '3' });
    try {
      const body = await (await fetch(`${dashboard.url}/api/photos`)).json();
      assert.equal(body.photos.length, 3);
      assert.equal(body.more, true);
    } finally {
      await dashboard.close();
      await immich.close();
    }
  });

  test('lists owned and shared albums once each, by name', async () => {
    const immich = await startImmich();
    const dashboard = await startDashboard({ IMMICH_URL: immich.url, IMMICH_API_KEY: IMMICH_KEY });
    try {
      const { albums } = await (await fetch(`${dashboard.url}/api/photos/albums`)).json();
      assert.deepEqual(albums.map((album) => album.name), ['Autumn walks', 'Family', 'Summer']);
      assert.deepEqual(albums[1], { id: ALBUM_SHARED, name: 'Family', count: 900, shared: true });
    } finally {
      await dashboard.close();
      await immich.close();
    }
  });

  test('lists named people only, by name', async () => {
    const immich = await startImmich();
    const dashboard = await startDashboard({ IMMICH_URL: immich.url, IMMICH_API_KEY: IMMICH_KEY });
    try {
      const { people } = await (await fetch(`${dashboard.url}/api/photos/people`)).json();
      assert.deepEqual(people, [{ id: PERSON_ANNA, name: 'Anna' }, { id: PERSON_BEN, name: 'Ben' }]);
    } finally {
      await dashboard.close();
      await immich.close();
    }
  });

  test('names the missing permission when the key cannot list albums or people', async () => {
    const immich = await startImmich({ forbidden: ['/api/albums', '/api/people'] });
    const dashboard = await startDashboard({ IMMICH_URL: immich.url, IMMICH_API_KEY: IMMICH_KEY });
    try {
      const albums = await fetch(`${dashboard.url}/api/photos/albums`);
      assert.equal(albums.status, 502);
      assert.match((await albums.json()).error, /album\.read/);
      const people = await fetch(`${dashboard.url}/api/photos/people`);
      assert.match((await people.json()).error, /person\.read/);
    } finally {
      await dashboard.close();
      await immich.close();
    }
  });

  test('album and people lists need Immich', async () => {
    const dashboard = await startDashboard({});
    try {
      assert.equal((await fetch(`${dashboard.url}/api/photos/albums`)).status, 503);
      assert.equal((await fetch(`${dashboard.url}/api/photos/people`)).status, 503);
    } finally {
      await dashboard.close();
    }
  });
});

describe('when Immich misbehaves', () => {
  test('explains that iOS 12 cannot show WebP previews', async () => {
    const immich = await startImmich({ previewType: 'image/webp' });
    const dashboard = await startDashboard({ IMMICH_URL: immich.url, IMMICH_API_KEY: IMMICH_KEY });
    try {
      const res = await fetch(`${dashboard.url}/api/photos/${ASSET_IMAGE}/image`);
      assert.equal(res.status, 502);
      const { error } = await res.json();
      assert.match(error, /image\/webp/);
      assert.match(error, /jpeg/i);
    } finally {
      await dashboard.close();
      await immich.close();
    }
  });

  test('a wrong API key is reported clearly', async () => {
    const immich = await startImmich();
    const dashboard = await startDashboard({ IMMICH_URL: immich.url, IMMICH_API_KEY: 'wrong-key' });
    try {
      const res = await fetch(`${dashboard.url}/api/photos`);
      assert.equal(res.status, 502);
      assert.match((await res.json()).error, /API key/);
    } finally {
      await dashboard.close();
      await immich.close();
    }
  });

  test('an unreachable Immich is reported clearly', async () => {
    // Port 1 is never listening, so the connection is refused straight away.
    const dashboard = await startDashboard({ IMMICH_URL: 'http://127.0.0.1:1', IMMICH_API_KEY: IMMICH_KEY });
    try {
      const res = await fetch(`${dashboard.url}/api/photos`);
      assert.equal(res.status, 502);
      assert.match((await res.json()).error, /Cannot reach Immich/);
    } finally {
      await dashboard.close();
    }
  });

  test('photos are off, with a clear message, when Immich is not configured', async () => {
    const dashboard = await startDashboard({});
    try {
      const res = await fetch(`${dashboard.url}/api/photos`);
      assert.equal(res.status, 503);
      assert.match((await res.json()).error, /IMMICH_URL/);
      const config = await (await fetch(`${dashboard.url}/api/config`)).json();
      assert.equal(config.photosEnabled, false);
    } finally {
      await dashboard.close();
    }
  });
});

describe('Home Assistant controls', () => {
  let ha;
  let dashboard;

  before(async () => {
    ha = await startHomeAssistant();
    dashboard = await startDashboard({
      HA_URL: ha.url,
      HA_TOKEN,
      HA_ENTITIES: 'script.evening_routine,cover.garage_door,automation.night_mode,light.nope',
      HA_HIDE_ENTITIES: 'fan.bathroom',
    });
  });

  after(async () => {
    await dashboard.close();
    await ha.close();
  });

  test('lists every light, cover, switch, scene, climate and sensor, grouped by room', async () => {
    const res = await fetch(`${dashboard.url}/api/ha/controls`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(body.configured, true);
    assert.equal(body.areasAvailable, true);
    assert.deepEqual(body.missing, ['light.nope']);
    assert.ok(ha.calls.every((call) => call.authorization === `Bearer ${HA_TOKEN}`));

    const byId = Object.fromEntries(body.entities.map((entity) => [entity.entity_id, entity]));
    for (const entityId of ['light.kitchen', 'light.hall', 'light.bedside', 'light.broken']) {
      assert.ok(byId[entityId], `${entityId} should be listed`);
    }
    assert.equal(byId['light.hall'].area, 'Living room');
    assert.equal(byId['light.hall'].brightness, 50);
    assert.equal(byId['light.bedside'].commands.includes('brightness'), false);
    assert.equal(byId['light.broken'].available, false);
    assert.equal(byId['light.broken'].area, 'Kitchen');
    assert.equal(byId['cover.living_room_blinds'].category, 'covers');
    assert.deepEqual(byId['cover.living_room_blinds'].commands, ['open', 'stop', 'close']);
    assert.equal(byId['climate.living_room'].climate.target, 21.5);
    assert.equal(byId['sensor.hall_temperature'].category, 'status');
    assert.equal(byId['sensor.hall_temperature'].unit, '°C');
    assert.deepEqual(byId['lock.front_door'].commands, []);
    assert.equal(byId['lock.front_door'].area, null);
  });

  test('hides internal entities, opt-in entities that are not listed, and hidden entities', async () => {
    const ids = (await (await fetch(`${dashboard.url}/api/ha/controls`)).json()).entities.map((entity) => entity.entity_id);
    for (const hidden of ['person.mike', 'sun.sun', 'button.restart_hub', 'group.all_lights', 'fan.bathroom']) {
      assert.equal(ids.includes(hidden), false, `${hidden} should not be listed`);
    }
    for (const listed of ['script.evening_routine', 'cover.garage_door', 'automation.night_mode']) {
      assert.equal(ids.includes(listed), true, `${listed} should be listed`);
    }
  });

  test('toggles a light and reports its new state', async () => {
    const res = await post(`${dashboard.url}/api/ha/entities/light.kitchen/command`, { command: 'toggle' });
    assert.equal(res.status, 200);
    const { entity } = await res.json();
    assert.equal(entity.on, true);
    assert.equal(ha.states['light.kitchen'].state, 'on');

    const call = ha.calls.findLast((request) => request.path === '/api/services/light/toggle');
    assert.deepEqual(JSON.parse(call.body), { entity_id: 'light.kitchen' });
  });

  test('sets light brightness as a percentage, and 0 switches the light off', async () => {
    const res = await post(`${dashboard.url}/api/ha/entities/light.hall/command`, { command: 'brightness', value: 40 });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).entity.brightness, 40);
    const call = ha.calls.findLast((request) => request.path === '/api/services/light/turn_on');
    assert.deepEqual(JSON.parse(call.body), { entity_id: 'light.hall', brightness_pct: 40 });

    await post(`${dashboard.url}/api/ha/entities/light.hall/command`, { command: 'brightness', value: 0 });
    assert.equal(ha.states['light.hall'].state, 'off');
    assert.ok(ha.calls.some((request) => request.path === '/api/services/light/turn_off'));
  });

  test('refuses brightness values outside 0 to 100, and brightness for lights that cannot dim', async () => {
    const tooBright = await post(`${dashboard.url}/api/ha/entities/light.hall/command`, { command: 'brightness', value: 150 });
    assert.equal(tooBright.status, 400);
    assert.match((await tooBright.json()).error, /0 to 100/);

    const notText = await post(`${dashboard.url}/api/ha/entities/light.hall/command`, { command: 'brightness', value: '50' });
    assert.equal(notText.status, 400);

    const onOff = await post(`${dashboard.url}/api/ha/entities/light.bedside/command`, { command: 'brightness', value: 30 });
    assert.equal(onOff.status, 400);
    assert.match((await onOff.json()).error, /cannot "brightness"/);
  });

  test('opens, stops and closes covers through their own services', async () => {
    const opened = await post(`${dashboard.url}/api/ha/entities/cover.living_room_blinds/command`, { command: 'open' });
    assert.equal((await opened.json()).entity.state, 'open');
    assert.ok(ha.calls.some((request) => request.path === '/api/services/cover/open_cover'));

    await post(`${dashboard.url}/api/ha/entities/cover.living_room_blinds/command`, { command: 'stop' });
    assert.ok(ha.calls.some((request) => request.path === '/api/services/cover/stop_cover'));

    const closed = await post(`${dashboard.url}/api/ha/entities/cover.living_room_blinds/command`, { command: 'close' });
    assert.equal((await closed.json()).entity.state, 'closed');
  });

  test('sets a climate target temperature within the entity limits', async () => {
    const res = await post(`${dashboard.url}/api/ha/entities/climate.living_room/command`, { command: 'temperature', value: 22 });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).entity.climate.target, 22);
    const call = ha.calls.findLast((request) => request.path === '/api/services/climate/set_temperature');
    assert.deepEqual(JSON.parse(call.body), { entity_id: 'climate.living_room', temperature: 22 });

    const tooHot = await post(`${dashboard.url}/api/ha/entities/climate.living_room/command`, { command: 'temperature', value: 40 });
    assert.equal(tooHot.status, 400);
  });

  test('runs scenes and listed scripts, and toggles listed automations', async () => {
    assert.equal((await post(`${dashboard.url}/api/ha/entities/scene.movie_night/command`, { command: 'run' })).status, 200);
    assert.ok(ha.calls.some((request) => request.path === '/api/services/scene/turn_on'));

    assert.equal((await post(`${dashboard.url}/api/ha/entities/script.evening_routine/command`, { command: 'run' })).status, 200);
    assert.ok(ha.calls.some((request) => request.path === '/api/services/script/turn_on'));

    const automation = await post(`${dashboard.url}/api/ha/entities/automation.night_mode/command`, { command: 'toggle' });
    assert.equal((await automation.json()).entity.on, false);
    assert.ok(ha.calls.some((request) => request.path === '/api/services/automation/toggle'));
  });

  test('refuses entities that are not on the panel and never calls a service for them', async () => {
    const isService = (request) => request.path.startsWith('/api/services/');
    const servicesBefore = ha.calls.filter(isService).length;
    for (const entityId of ['fan.bathroom', 'button.restart_hub', 'group.all_lights', 'light.bedroom_ghost']) {
      const res = await post(`${dashboard.url}/api/ha/entities/${entityId}/command`, { command: 'toggle' });
      assert.ok([403, 404].includes(res.status), `${entityId} should be refused, got ${res.status}`);
    }
    assert.equal(ha.calls.filter(isService).length, servicesBefore);
  });

  test('locks and sensors can be read but never commanded', async () => {
    const lock = await post(`${dashboard.url}/api/ha/entities/lock.front_door/command`, { command: 'toggle' });
    assert.equal(lock.status, 400);
    assert.match((await lock.json()).error, /cannot "toggle"/);

    const sensor = await post(`${dashboard.url}/api/ha/entities/sensor.hall_temperature/command`, { command: 'toggle' });
    assert.equal(sensor.status, 400);
    assert.equal(ha.states['lock.front_door'].state, 'locked');
  });

  test('rejects unknown entities and malformed requests', async () => {
    assert.equal((await post(`${dashboard.url}/api/ha/entities/light.ghost/command`, { command: 'toggle' })).status, 404);
    assert.equal((await post(`${dashboard.url}/api/ha/entities/Light.Kitchen/command`, { command: 'toggle' })).status, 400);
    assert.equal((await post(`${dashboard.url}/api/ha/entities/light.kitchen/command`, '{not json')).status, 400);
    assert.equal((await post(`${dashboard.url}/api/ha/entities/light.kitchen/command`, [1, 2])).status, 400);
    assert.equal((await post(`${dashboard.url}/api/ha/entities/light.kitchen/command`, { command: 'explode' })).status, 400);
    assert.equal((await post(`${dashboard.url}/api/ha/entities/light.kitchen/command`, { command: 'toggle', value: 1 })).status, 400);
    const oversized = await post(`${dashboard.url}/api/ha/entities/light.kitchen/command`, { command: 'toggle', padding: 'x'.repeat(2000) });
    assert.equal(oversized.status, 413);
  });

  test('only accepts POST for commands and room actions', async () => {
    const command = await fetch(`${dashboard.url}/api/ha/entities/light.kitchen/command`);
    assert.equal(command.status, 405);
    assert.equal(command.headers.get('allow'), 'POST');
    const room = await fetch(`${dashboard.url}/api/ha/rooms/kitchen/lights-off`);
    assert.equal(room.status, 405);
  });

  test('turns off every light in a room with one request', async () => {
    assert.equal(ha.states['light.hall'].state, 'off', 'the earlier brightness test left the hall light off');
    await post(`${dashboard.url}/api/ha/entities/light.hall/command`, { command: 'toggle' });
    assert.equal(ha.states['light.hall'].state, 'on');

    const res = await post(`${dashboard.url}/api/ha/rooms/living_room/lights-off`, {});
    assert.equal(res.status, 200);
    assert.equal(ha.states['light.hall'].state, 'off');
    const call = ha.calls.findLast((request) => request.path === '/api/services/light/turn_off');
    assert.deepEqual(JSON.parse(call.body), { entity_id: ['light.hall'] });
  });

  test('turning off a room leaves its hidden lights alone', async () => {
    const hiddenHa = await startHomeAssistant();
    const hiddenDashboard = await startDashboard({ HA_URL: hiddenHa.url, HA_TOKEN, HA_HIDE_ENTITIES: 'light.kitchen' });
    try {
      hiddenHa.states['light.kitchen'].state = 'on';
      assert.equal((await post(`${hiddenDashboard.url}/api/ha/rooms/kitchen/lights-off`, {})).status, 200);
      assert.equal(hiddenHa.states['light.kitchen'].state, 'on');
      const call = hiddenHa.calls.findLast((request) => request.path === '/api/services/light/turn_off');
      assert.deepEqual(JSON.parse(call.body), { entity_id: ['light.broken'] });

      // A room whose lights are all hidden gets no service call at all.
      const before = hiddenHa.calls.length;
      const bedroom = await startDashboard({ HA_URL: hiddenHa.url, HA_TOKEN, HA_HIDE_ENTITIES: 'light.bedside' });
      try {
        assert.equal((await post(`${bedroom.url}/api/ha/rooms/bedroom/lights-off`, {})).status, 200);
        assert.equal(hiddenHa.calls.slice(before).some((request) => request.path.startsWith('/api/services/')), false);
      } finally {
        await bedroom.close();
      }
    } finally {
      await hiddenDashboard.close();
      await hiddenHa.close();
    }
  });

  test('rejects rooms that do not exist and malformed room ids', async () => {
    assert.equal((await post(`${dashboard.url}/api/ha/rooms/attic/lights-off`, {})).status, 404);
    assert.equal((await post(`${dashboard.url}/api/ha/rooms/Kitchen/lights-off`, {})).status, 400);
  });
});

describe('light colours and whole-room commands', () => {
  let ha;
  let dashboard;

  before(async () => {
    ha = await startHomeAssistant();
    dashboard = await startDashboard({ HA_URL: ha.url, HA_TOKEN });
  });

  after(async () => {
    await dashboard.close();
    await ha.close();
  });

  const lights = (body) => post(`${dashboard.url}/api/ha/lights`, body);
  const lastService = (path) => JSON.parse(ha.calls.findLast((request) => request.path === path).body);

  test('reports which lights take a colour or a white tone, and the colour they show', async () => {
    const byId = Object.fromEntries((await (await fetch(`${dashboard.url}/api/ha/controls`)).json()).entities
      .map((entity) => [entity.entity_id, entity]));
    assert.deepEqual(byId['light.strip'].commands, ['toggle', 'brightness', 'color', 'color_temp']);
    assert.deepEqual(byId['light.strip'].color.rgb, [0, 120, 255]);
    assert.deepEqual(byId['light.ceiling'].commands, ['toggle', 'brightness', 'color_temp']);
    assert.equal(byId['light.ceiling'].color.minKelvin, 2700);
    assert.equal(byId['light.ceiling'].color.rgb, null, 'an off light shows no colour');
    assert.equal(byId['light.kitchen'].color, null);
    assert.deepEqual(byId['light.kitchen'].commands, ['toggle', 'brightness']);
  });

  test('sets a colour, which also switches the light on', async () => {
    const res = await post(`${dashboard.url}/api/ha/entities/light.strip/command`, { command: 'color', value: [255, 0, 80] });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).entity.color.rgb, [255, 0, 80]);
    assert.deepEqual(lastService('/api/services/light/turn_on'), { entity_id: 'light.strip', rgb_color: [255, 0, 80] });
  });

  test('keeps a white tone inside the light\'s own range', async () => {
    const res = await post(`${dashboard.url}/api/ha/entities/light.ceiling/command`, { command: 'color_temp', value: 2200 });
    assert.equal(res.status, 200);
    assert.deepEqual(lastService('/api/services/light/turn_on'), { entity_id: 'light.ceiling', color_temp_kelvin: 2700 });
    assert.equal(ha.states['light.ceiling'].state, 'on');
  });

  test('refuses colours for lights without them, and malformed colours', async () => {
    const refusals = [
      ['light.ceiling', { command: 'color', value: [255, 0, 0] }, /cannot "color"/],
      ['light.kitchen', { command: 'color_temp', value: 3000 }, /cannot "color_temp"/],
      ['light.strip', { command: 'color', value: [256, 0, 0] }, /0 to 255/],
      ['light.strip', { command: 'color', value: '#ff0000' }, /0 to 255/],
      ['light.strip', { command: 'color_temp', value: 90000 }, /kelvin/],
    ];
    for (const [entityId, body, message] of refusals) {
      const res = await post(`${dashboard.url}/api/ha/entities/${entityId}/command`, body);
      assert.equal(res.status, 400, `${entityId} ${JSON.stringify(body)}`);
      assert.match((await res.json()).error, message);
    }
  });

  test('All on and All off reach every light on the panel, or the lights in one room', async () => {
    const on = await lights({ command: 'on' });
    assert.equal(on.status, 200);
    const allIds = lastService('/api/services/light/turn_on').entity_id;
    assert.deepEqual([...allIds].sort(), ['light.bedside', 'light.broken', 'light.ceiling', 'light.hall', 'light.kitchen', 'light.strip']);
    assert.equal((await on.json()).count, 6);
    assert.equal(ha.states['light.kitchen'].state, 'on');

    assert.equal((await lights({ command: 'off', area: 'office' })).status, 200);
    assert.deepEqual(lastService('/api/services/light/turn_off'), { entity_id: ['light.ceiling', 'light.strip'] });
    assert.equal(ha.states['light.kitchen'].state, 'on', 'other rooms are left alone');
  });

  test('a colour for many lights only goes to the colour lights', async () => {
    const res = await lights({ command: 'color', value: [255, 140, 0] });
    assert.equal((await res.json()).count, 1);
    assert.deepEqual(lastService('/api/services/light/turn_on'), { entity_id: ['light.strip'], rgb_color: [255, 140, 0] });
  });

  test('a white tone for many lights fits each light\'s range, so the calls are split by tone', async () => {
    const before = ha.calls.length;
    const res = await lights({ command: 'color_temp', value: 2200, area: 'office' });
    assert.equal((await res.json()).count, 2);
    const bodies = ha.calls.slice(before)
      .filter((request) => request.path === '/api/services/light/turn_on')
      .map((request) => JSON.parse(request.body));
    assert.deepEqual(bodies, [
      { entity_id: ['light.ceiling'], color_temp_kelvin: 2700 },
      { entity_id: ['light.strip'], color_temp_kelvin: 2200 },
    ]);
  });

  test('group commands are checked like single ones', async () => {
    assert.equal((await lights({ command: 'explode' })).status, 400);
    assert.equal((await lights({ command: 'on', value: 1 })).status, 400);
    assert.equal((await lights({ command: 'color', value: [1, 2] })).status, 400);
    assert.equal((await lights({ command: 'on', area: 'attic' })).status, 404);
    assert.equal((await lights({ command: 'on', area: 'Office' })).status, 400);
    assert.equal((await lights({ command: 'on', area: 5 })).status, 400);
    assert.equal((await fetch(`${dashboard.url}/api/ha/lights`)).status, 405);
  });

  test('lights hidden in the settings menu are left out of group commands', async () => {
    await fetch(`${dashboard.url}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hiddenEntities: ['light.ceiling'] }),
    });
    try {
      await lights({ command: 'off', area: 'office' });
      assert.deepEqual(lastService('/api/services/light/turn_off'), { entity_id: ['light.strip'] });
    } finally {
      await fetch(`${dashboard.url}/api/settings`, { method: 'DELETE' });
    }
  });
});

describe('Home Assistant defaults and caching', () => {
  test('without HA_ENTITIES, garage doors and scripts stay off the panel', async () => {
    const ha = await startHomeAssistant();
    const dashboard = await startDashboard({ HA_URL: ha.url, HA_TOKEN });
    try {
      const ids = (await (await fetch(`${dashboard.url}/api/ha/controls`)).json()).entities.map((entity) => entity.entity_id);
      assert.equal(ids.includes('cover.garage_door'), false);
      assert.equal(ids.includes('script.evening_routine'), false);
      const garage = await post(`${dashboard.url}/api/ha/entities/cover.garage_door/command`, { command: 'open' });
      assert.equal(garage.status, 403);
      const serviceCalls = ha.calls.filter((request) => request.path.startsWith('/api/services/'));
      assert.equal(serviceCalls.some((request) => request.body.includes('garage')), false);
    } finally {
      await dashboard.close();
      await ha.close();
    }
  });

  test('shares one entity list between requests inside the cache window', async () => {
    const ha = await startHomeAssistant();
    let clock = 1000;
    const dashboard = await startDashboard({ HA_URL: ha.url, HA_TOKEN }, { now: () => clock });
    try {
      await fetch(`${dashboard.url}/api/ha/controls`);
      await fetch(`${dashboard.url}/api/ha/controls`);
      assert.equal(ha.calls.filter((call) => call.path === '/api/states').length, 1);
      assert.equal(ha.calls.filter((call) => call.path === '/api/template').length, 1);

      clock += 5000;
      await fetch(`${dashboard.url}/api/ha/controls`);
      assert.equal(ha.calls.filter((call) => call.path === '/api/states').length, 2);
      assert.equal(ha.calls.filter((call) => call.path === '/api/template').length, 1, 'rooms are kept for a minute');
    } finally {
      await dashboard.close();
      await ha.close();
    }
  });

  test('still lists controls, under No room, when Home Assistant cannot list rooms', async () => {
    const ha = await startHomeAssistant({ failRooms: true });
    const dashboard = await startDashboard({ HA_URL: ha.url, HA_TOKEN });
    try {
      const body = await (await fetch(`${dashboard.url}/api/ha/controls`)).json();
      assert.equal(body.areasAvailable, false);
      assert.ok(body.entities.length > 0);
      assert.ok(body.entities.every((entity) => entity.area === null));
    } finally {
      await dashboard.close();
      await ha.close();
    }
  });

  test('reports a failed entity list as a bad gateway', async () => {
    const ha = await startHomeAssistant({ failStates: true });
    const dashboard = await startDashboard({ HA_URL: ha.url, HA_TOKEN });
    try {
      const res = await fetch(`${dashboard.url}/api/ha/controls`);
      assert.equal(res.status, 502);
      assert.match((await res.json()).error, /HTTP 500/);
    } finally {
      await dashboard.close();
      await ha.close();
    }
  });
});

describe('Home Assistant with a wrong token or not configured', () => {
  test('controls and commands explain the token problem', async () => {
    const ha = await startHomeAssistant();
    const dashboard = await startDashboard({ HA_URL: ha.url, HA_TOKEN: 'wrong-token' });
    try {
      const list = await fetch(`${dashboard.url}/api/ha/controls`);
      assert.equal(list.status, 502);
      assert.match((await list.json()).error, /access token/);

      const command = await post(`${dashboard.url}/api/ha/entities/light.kitchen/command`, { command: 'toggle' });
      assert.equal(command.status, 502);
      assert.match((await command.json()).error, /access token/);
    } finally {
      await dashboard.close();
      await ha.close();
    }
  });

  test('reports Home Assistant as off when it is not configured', async () => {
    const dashboard = await startDashboard({});
    try {
      const body = await (await fetch(`${dashboard.url}/api/ha/controls`)).json();
      assert.deepEqual(body, { configured: false, areasAvailable: false, entities: [], missing: [] });
      const command = await post(`${dashboard.url}/api/ha/entities/light.kitchen/command`, { command: 'toggle' });
      assert.equal(command.status, 503);
    } finally {
      await dashboard.close();
    }
  });
});

describe('serving the frontend and the basic API', () => {
  let dashboard;

  before(async () => {
    dashboard = await startDashboard({ SLIDE_INTERVAL_SECONDS: '45', PHOTO_FIT: 'contain' });
  });

  after(async () => {
    await dashboard.close();
  });

  test('serves the page with the iOS home-screen tags', async () => {
    const res = await fetch(`${dashboard.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    const html = await res.text();
    assert.match(html, /apple-mobile-web-app-capable/);
    assert.match(html, /<script src="app.js">/);
  });

  test('serves scripts and styles with the right content types', async () => {
    const script = await fetch(`${dashboard.url}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /^text\/javascript/);

    const style = await fetch(`${dashboard.url}/style.css`);
    assert.equal(style.status, 200);
    assert.match(style.headers.get('content-type'), /^text\/css/);
  });

  test('config tells the page how the frame should behave', async () => {
    const config = await (await fetch(`${dashboard.url}/api/config`)).json();
    assert.equal(config.intervalSeconds, 45);
    assert.equal(config.photoFit, 'contain');
    assert.equal(config.showClock, true);
    assert.equal(config.photosEnabled, false);
    assert.equal(config.homeAssistantEnabled, false);
    assert.match(config.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test('never serves files outside public/', async () => {
    const res = await fetch(`${dashboard.url}/%2e%2e/package.json`);
    assert.equal(res.status, 404);
  });

  test('unknown files and API routes are 404', async () => {
    assert.equal((await fetch(`${dashboard.url}/missing.js`)).status, 404);
    assert.equal((await fetch(`${dashboard.url}/api/nope`)).status, 404);
  });

  test('static files only accept GET and HEAD', async () => {
    const res = await fetch(`${dashboard.url}/`, { method: 'POST' });
    assert.equal(res.status, 405);
  });

  test('the health check answers without calling any upstream service', async () => {
    const res = await fetch(`${dashboard.url}/api/health`);
    assert.deepEqual(await res.json(), { ok: true });
  });
});
