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
    assert.deepEqual(JSON.parse(call.body), { area_id: 'living_room' });
  });

  test('rejects rooms that do not exist and malformed room ids', async () => {
    assert.equal((await post(`${dashboard.url}/api/ha/rooms/attic/lights-off`, {})).status, 404);
    assert.equal((await post(`${dashboard.url}/api/ha/rooms/Kitchen/lights-off`, {})).status, 400);
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
