import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { supportsFilterSearch } from '../src/immich.js';
import {
  ALBUM_ID,
  ASSET_IMAGE,
  ASSET_MISSING,
  HA_TOKEN,
  IMMICH_KEY,
  PREVIEW_JPEG,
  startDashboard,
  startHomeAssistant,
  startImmich,
} from './support.js';

const LIGHT_KITCHEN = { entity_id: 'light.kitchen', state: 'off', attributes: { friendly_name: 'Kitchen light' } };
const SWITCH_COFFEE = { entity_id: 'switch.coffee', state: 'on', attributes: { friendly_name: 'Coffee machine' } };
const SENSOR_HALL = {
  entity_id: 'sensor.hall_temperature',
  state: '21.5',
  attributes: { friendly_name: 'Hall temperature', unit_of_measurement: '°C' },
};
const LOCK_DOOR = { entity_id: 'lock.front_door', state: 'locked', attributes: { friendly_name: 'Front door' } };
const SCENE_MOVIE = {
  entity_id: 'scene.movie_night',
  state: '2024-03-12T20:00:00+00:00',
  attributes: { friendly_name: 'Movie night' },
};
const LIGHT_BEDROOM = { entity_id: 'light.bedroom', state: 'off', attributes: { friendly_name: 'Bedroom light' } };

test('filter-style search is used from Immich 3.2 onwards only', () => {
  assert.equal(supportsFilterSearch({ major: 2, minor: 9 }), false);
  assert.equal(supportsFilterSearch({ major: 3, minor: 1 }), false);
  assert.equal(supportsFilterSearch({ major: 3, minor: 2 }), true);
  assert.equal(supportsFilterSearch({ major: 4, minor: 0 }), true);
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
    const { photos } = await res.json();
    assert.deepEqual(photos, [{ id: ASSET_IMAGE, takenAt: '2024-03-12T14:21:30.000Z' }]);

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
    ha = await startHomeAssistant({
      'light.kitchen': LIGHT_KITCHEN,
      'switch.coffee': SWITCH_COFFEE,
      'sensor.hall_temperature': SENSOR_HALL,
      'lock.front_door': LOCK_DOOR,
      'scene.movie_night': SCENE_MOVIE,
      'light.bedroom': LIGHT_BEDROOM,
    });
    dashboard = await startDashboard({
      HA_URL: ha.url,
      HA_TOKEN,
      HA_ENTITIES: 'light.kitchen,switch.coffee,sensor.hall_temperature,lock.front_door,scene.movie_night,light.missing',
    });
  });

  after(async () => {
    await dashboard.close();
    await ha.close();
  });

  test('lists only the configured entities, with the right kinds and states', async () => {
    const res = await fetch(`${dashboard.url}/api/ha/entities`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.configured, true);

    const byId = Object.fromEntries(body.entities.map((entity) => [entity.entity_id, entity]));
    assert.deepEqual(Object.keys(byId), [
      'light.kitchen',
      'switch.coffee',
      'sensor.hall_temperature',
      'lock.front_door',
      'scene.movie_night',
      'light.missing',
    ]);
    assert.deepEqual(byId['light.kitchen'], {
      entity_id: 'light.kitchen',
      name: 'Kitchen light',
      domain: 'light',
      kind: 'toggle',
      state: 'off',
      unit: null,
      on: false,
      available: true,
    });
    assert.equal(byId['switch.coffee'].on, true);
    assert.equal(byId['sensor.hall_temperature'].kind, 'info');
    assert.equal(byId['sensor.hall_temperature'].unit, '°C');
    assert.equal(byId['lock.front_door'].kind, 'info', 'locks are display-only');
    assert.equal(byId['scene.movie_night'].kind, 'press');
    assert.equal(byId['light.missing'].available, false);
    assert.equal(byId['light.missing'].error, 'Not found in Home Assistant');
    assert.ok(ha.calls.every((call) => call.authorization === `Bearer ${HA_TOKEN}`));
  });

  test('toggles an allowed light and reports its new state', async () => {
    const res = await fetch(`${dashboard.url}/api/ha/entities/light.kitchen/action`, { method: 'POST' });
    assert.equal(res.status, 200);
    const { entity } = await res.json();
    assert.equal(entity.on, true);

    const call = ha.calls.findLast((request) => request.path === '/api/services/light/toggle');
    assert.equal(call.method, 'POST');
    assert.deepEqual(JSON.parse(call.body), { entity_id: 'light.kitchen' });
  });

  test('runs a scene through scene.turn_on', async () => {
    const res = await fetch(`${dashboard.url}/api/ha/entities/scene.movie_night/action`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.ok(ha.calls.some((call) => call.path === '/api/services/scene/turn_on'));
  });

  test('refuses entities that are not listed in HA_ENTITIES, without calling Home Assistant', async () => {
    const res = await fetch(`${dashboard.url}/api/ha/entities/light.bedroom/action`, { method: 'POST' });
    assert.equal(res.status, 403);
    assert.equal(ha.calls.some((call) => call.body.includes('light.bedroom')), false);
  });

  test('will not control domains such as locks, even when they are listed', async () => {
    const res = await fetch(`${dashboard.url}/api/ha/entities/lock.front_door/action`, { method: 'POST' });
    assert.equal(res.status, 400);
    assert.equal(ha.calls.some((call) => call.path.includes('/lock/')), false);
  });

  test('rejects malformed entity ids', async () => {
    const res = await fetch(`${dashboard.url}/api/ha/entities/Light.Kitchen/action`, { method: 'POST' });
    assert.equal(res.status, 400);
  });

  test('only accepts POST for actions', async () => {
    const res = await fetch(`${dashboard.url}/api/ha/entities/light.kitchen/action`);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
  });
});

describe('Home Assistant with a wrong token or not configured', () => {
  test('entities show as unavailable and the action explains the token problem', async () => {
    const ha = await startHomeAssistant({ 'light.kitchen': LIGHT_KITCHEN });
    const dashboard = await startDashboard({ HA_URL: ha.url, HA_TOKEN: 'wrong-token', HA_ENTITIES: 'light.kitchen' });
    try {
      const body = await (await fetch(`${dashboard.url}/api/ha/entities`)).json();
      assert.equal(body.entities[0].available, false);

      const action = await fetch(`${dashboard.url}/api/ha/entities/light.kitchen/action`, { method: 'POST' });
      assert.equal(action.status, 502);
      assert.match((await action.json()).error, /access token/);
    } finally {
      await dashboard.close();
      await ha.close();
    }
  });

  test('reports Home Assistant as off when it is not configured', async () => {
    const dashboard = await startDashboard({});
    try {
      const body = await (await fetch(`${dashboard.url}/api/ha/entities`)).json();
      assert.deepEqual(body, { configured: false, entities: [] });
      const action = await fetch(`${dashboard.url}/api/ha/entities/light.kitchen/action`, { method: 'POST' });
      assert.equal(action.status, 503);
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
