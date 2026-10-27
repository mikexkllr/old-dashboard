import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createSettingsStore, settingsDefaults } from '../src/settings.js';
import { ALBUM_ID, HA_TOKEN, IMMICH_KEY, startDashboard, startHomeAssistant, startImmich } from './support.js';

const quiet = { warn() {} };
const defaults = () => settingsDefaults(loadConfig({ SLIDE_INTERVAL_SECONDS: '45' }));

const put = (url, body) => fetch(url, {
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'old-dashboard-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('the settings store', () => {
  test('starts from the environment defaults', () => {
    const store = createSettingsStore({ defaults: defaults(), logger: quiet });
    const state = store.state();
    assert.equal(state.settings.intervalSeconds, 45);
    assert.equal(state.settings.fromYear, null);
    assert.deepEqual(state.settings.hiddenEntities, []);
    assert.deepEqual(state.changed, []);
    assert.equal(state.saved, false, 'without a file nothing outlasts a restart');
    assert.match(state.problem, /SETTINGS_FILE/);
  });

  test('a menu value replaces its default, and choosing the default again forgets it', async () => {
    const store = createSettingsStore({ defaults: defaults(), logger: quiet });
    const changed = await store.update({ intervalSeconds: 10, fromYear: 2015 });
    assert.equal(changed.settings.intervalSeconds, 10);
    assert.equal(changed.settings.fromYear, 2015);
    assert.deepEqual(changed.changed.sort(), ['fromYear', 'intervalSeconds']);
    assert.equal(changed.revision, 1);

    const back = await store.update({ intervalSeconds: 45 });
    assert.deepEqual(back.changed, ['fromYear']);
    assert.equal(back.revision, 2);
  });

  test('checks every value before changing anything', async () => {
    const store = createSettingsStore({ defaults: defaults(), logger: quiet });
    const refusals = [
      [{ intervalSeconds: 0 }, /intervalSeconds/],
      [{ intervalSeconds: '30' }, /intervalSeconds/],
      [{ photoFit: 'stretch' }, /photoFit/],
      [{ showClock: 'yes' }, /showClock/],
      [{ albumIds: ['my-album'] }, /album id/],
      [{ hiddenEntities: ['Light.Kitchen'] }, /entity id/],
      [{ fromYear: 1800 }, /fromYear/],
      [{ fromYear: 2020, toYear: 2015 }, /after the until year/],
      [{ unknown: true }, /Unknown setting/],
      [[1, 2], /JSON object/],
    ];
    for (const [patch, message] of refusals) {
      await assert.rejects(store.update(patch), (err) => err.status === 400 && message.test(err.message), JSON.stringify(patch));
    }
    // A bad value in a patch leaves the good ones in it unapplied too.
    await assert.rejects(store.update({ showClock: false, photoFit: 'stretch' }));
    assert.equal(store.current().showClock, true);
    assert.equal(store.revision, 0);
  });

  test('lists lose their duplicates, and years can be cleared to any year', async () => {
    const store = createSettingsStore({
      defaults: settingsDefaults(loadConfig({ IMMICH_FROM_YEAR: '2010' })),
      logger: quiet,
    });
    const state = await store.update({ albumIds: [ALBUM_ID, ALBUM_ID], fromYear: null });
    assert.deepEqual(state.settings.albumIds, [ALBUM_ID]);
    assert.equal(state.settings.fromYear, null);
    assert.ok(state.changed.includes('fromYear'), 'clearing a year set in the environment is a change');
  });

  test('reset goes back to the environment values', async () => {
    const store = createSettingsStore({ defaults: defaults(), logger: quiet });
    await store.update({ showClock: false, favoritesOnly: true });
    const state = await store.reset();
    assert.equal(state.settings.showClock, true);
    assert.equal(state.settings.favoritesOnly, false);
    assert.deepEqual(state.changed, []);
  });

  test('saves changes to its file and reads them back after a restart', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'data', 'settings.json');
      const first = createSettingsStore({ defaults: defaults(), file, logger: quiet });
      await first.load();
      const state = await first.update({ toYear: 2020, hiddenEntities: ['sensor.noise'] });
      assert.equal(state.saved, true);
      assert.equal(state.problem, null);

      const stored = JSON.parse(await readFile(file, 'utf8'));
      assert.deepEqual(stored, { version: 1, settings: { toYear: 2020, hiddenEntities: ['sensor.noise'] } });

      const second = createSettingsStore({ defaults: defaults(), file, logger: quiet });
      await second.load();
      assert.equal(second.current().toYear, 2020);
      assert.deepEqual(second.current().hiddenEntities, ['sensor.noise']);
    });
  });

  test('skips unreadable, unknown and invalid saved values instead of failing to start', async () => {
    await withTempDir(async (dir) => {
      const warnings = [];
      const logger = { warn: (message) => warnings.push(message) };

      const broken = path.join(dir, 'broken.json');
      await writeFile(broken, '{ not json');
      const fromBroken = createSettingsStore({ defaults: defaults(), file: broken, logger });
      await fromBroken.load();
      assert.equal(fromBroken.current().intervalSeconds, 45);

      const mixed = path.join(dir, 'mixed.json');
      await writeFile(mixed, JSON.stringify({ version: 1, settings: { intervalSeconds: 20, photoFit: 'stretch', colour: 'red' } }));
      const fromMixed = createSettingsStore({ defaults: defaults(), file: mixed, logger });
      await fromMixed.load();
      assert.equal(fromMixed.current().intervalSeconds, 20);
      assert.equal(fromMixed.current().photoFit, 'auto');
      assert.equal(warnings.length, 3);
    });
  });

  test('drops saved years that a later environment change made impossible', async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'settings.json');
      await writeFile(file, JSON.stringify({ version: 1, settings: { fromYear: 2020 } }));
      const store = createSettingsStore({
        defaults: settingsDefaults(loadConfig({ IMMICH_TO_YEAR: '2015' })),
        file,
        logger: quiet,
      });
      await store.load();
      assert.equal(store.current().fromYear, null);
      assert.equal(store.current().toYear, 2015);
    });
  });

  test('keeps changes in memory, and says so, when the file cannot be written', async () => {
    await withTempDir(async (dir) => {
      const blocker = path.join(dir, 'not-a-directory');
      await writeFile(blocker, 'x');
      const store = createSettingsStore({ defaults: defaults(), file: path.join(blocker, 'settings.json'), logger: quiet });
      await store.load();
      const state = await store.update({ showCaptions: false });
      assert.equal(state.settings.showCaptions, false);
      assert.equal(state.saved, false);
      assert.match(state.problem, /lost when the server restarts/);
    });
  });
});

describe('the settings API', () => {
  test('changes the frame settings the page reads, and resets them', async () => {
    const dashboard = await startDashboard({ SLIDE_INTERVAL_SECONDS: '45' });
    try {
      const initial = await (await fetch(`${dashboard.url}/api/settings`)).json();
      assert.equal(initial.settings.intervalSeconds, 45);
      assert.equal(initial.defaults.intervalSeconds, 45);
      assert.equal(initial.photosEnabled, false);
      const before = await (await fetch(`${dashboard.url}/api/config`)).json();

      const res = await put(`${dashboard.url}/api/settings`, { intervalSeconds: 15, photoFit: 'contain', showClock: false });
      assert.equal(res.status, 200);
      assert.deepEqual((await res.json()).changed.sort(), ['intervalSeconds', 'photoFit', 'showClock']);

      const config = await (await fetch(`${dashboard.url}/api/config`)).json();
      assert.equal(config.intervalSeconds, 15);
      assert.equal(config.photoFit, 'contain');
      assert.equal(config.showClock, false);
      assert.notEqual(config.settingsRevision, before.settingsRevision, 'other screens notice the change');

      const reset = await fetch(`${dashboard.url}/api/settings`, { method: 'DELETE' });
      assert.equal(reset.status, 200);
      assert.equal((await (await fetch(`${dashboard.url}/api/config`)).json()).intervalSeconds, 45);
    } finally {
      await dashboard.close();
    }
  });

  test('refuses invalid settings with a 400, and other methods with a 405', async () => {
    const dashboard = await startDashboard({});
    try {
      const bad = await put(`${dashboard.url}/api/settings`, { intervalSeconds: -5 });
      assert.equal(bad.status, 400);
      assert.match((await bad.json()).error, /intervalSeconds/);

      const post = await fetch(`${dashboard.url}/api/settings`, { method: 'POST' });
      assert.equal(post.status, 405);
      assert.equal(post.headers.get('allow'), 'GET, PUT, DELETE');
    } finally {
      await dashboard.close();
    }
  });

  test('accepts long album and entity lists', async () => {
    const dashboard = await startDashboard({});
    try {
      const hiddenEntities = Array.from({ length: 400 }, (_, i) => `sensor.noisy_sensor_number_${i}`);
      const res = await put(`${dashboard.url}/api/settings`, { hiddenEntities });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).settings.hiddenEntities.length, 400);
    } finally {
      await dashboard.close();
    }
  });

  test('settings saved to a file survive a restart of the dashboard', async () => {
    await withTempDir(async (dir) => {
      const settingsFile = path.join(dir, 'settings.json');
      const first = await startDashboard({}, { settingsFile });
      try {
        const state = await (await put(`${first.url}/api/settings`, { showCaptions: false })).json();
        assert.equal(state.saved, true);
      } finally {
        await first.close();
      }
      const second = await startDashboard({}, { settingsFile });
      try {
        assert.equal((await (await fetch(`${second.url}/api/config`)).json()).showCaptions, false);
      } finally {
        await second.close();
      }
    });
  });

  test('photo filters chosen in the menu reach the Immich search', async () => {
    const immich = await startImmich();
    const dashboard = await startDashboard({ IMMICH_URL: immich.url, IMMICH_API_KEY: IMMICH_KEY });
    try {
      await put(`${dashboard.url}/api/settings`, { fromYear: 2015, favoritesOnly: true });
      await fetch(`${dashboard.url}/api/photos`);
      const search = immich.calls.findLast((call) => call.path === '/api/search/random');
      assert.deepEqual(JSON.parse(search.body).filter, {
        type: { eq: 'IMAGE' },
        visibility: { eq: 'timeline' },
        isFavorite: { eq: true },
        takenAt: { gte: '2015-01-01T00:00:00.000Z' },
      });
    } finally {
      await dashboard.close();
      await immich.close();
    }
  });

  test('entities hidden in the menu leave the panel and cannot be commanded', async () => {
    const ha = await startHomeAssistant();
    const dashboard = await startDashboard({ HA_URL: ha.url, HA_TOKEN, HA_HIDE_ENTITIES: 'fan.bathroom' });
    try {
      await put(`${dashboard.url}/api/settings`, { hiddenEntities: ['light.kitchen'] });

      const ids = (await (await fetch(`${dashboard.url}/api/ha/controls`)).json()).entities.map((entity) => entity.entity_id);
      assert.equal(ids.includes('light.kitchen'), false);

      const command = await fetch(`${dashboard.url}/api/ha/entities/light.kitchen/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'toggle' }),
      });
      assert.equal(command.status, 403);
      assert.equal(ha.calls.some((call) => call.path.startsWith('/api/services/')), false);

      // The menu still lists it, so it can be shown again. HA_HIDE_ENTITIES stays out.
      const choices = await (await fetch(`${dashboard.url}/api/settings/entities`)).json();
      const listed = choices.entities.map((entity) => entity.entity_id);
      assert.ok(listed.includes('light.kitchen'));
      assert.equal(listed.includes('fan.bathroom'), false);
      assert.deepEqual(Object.keys(choices.entities[0]).sort(), ['area', 'category', 'entity_id', 'name']);
    } finally {
      await dashboard.close();
      await ha.close();
    }
  });

  test('the entity list is empty when Home Assistant is off', async () => {
    const dashboard = await startDashboard({});
    try {
      assert.deepEqual(await (await fetch(`${dashboard.url}/api/settings/entities`)).json(), { configured: false, entities: [] });
    } finally {
      await dashboard.close();
    }
  });
});
