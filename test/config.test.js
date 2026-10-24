import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { ALBUM_ID } from './support.js';

test('everything is optional, with sensible defaults', () => {
  const config = loadConfig({});
  assert.equal(config.port, 3000);
  assert.equal(config.frame.intervalSeconds, 60);
  assert.equal(config.frame.photoFit, 'auto');
  assert.equal(config.frame.showClock, true);
  assert.equal(config.frame.panelIdleSeconds, 60);
  assert.equal(config.immich.url, '');
  assert.equal(config.homeAssistant.url, '');
});

test('trailing slashes and a pasted /api suffix are tidied from IMMICH_URL', () => {
  const config = loadConfig({ IMMICH_URL: 'http://192.168.1.20:2283/api/', IMMICH_API_KEY: 'k' });
  assert.equal(config.immich.url, 'http://192.168.1.20:2283');
});

test('Immich needs both its URL and key', () => {
  assert.throws(() => loadConfig({ IMMICH_URL: 'http://192.168.1.20:2283' }), /IMMICH_URL and IMMICH_API_KEY/);
  assert.throws(() => loadConfig({ IMMICH_API_KEY: 'k' }), /IMMICH_URL and IMMICH_API_KEY/);
});

test('Home Assistant needs both its URL and token', () => {
  assert.throws(() => loadConfig({ HA_TOKEN: 't' }), /HA_URL and HA_TOKEN/);
});

test('URLs must be http or https', () => {
  assert.throws(() => loadConfig({ HA_URL: 'ftp://ha.local', HA_TOKEN: 't' }), /http:\/\/ or https:\/\//);
  assert.throws(() => loadConfig({ HA_URL: 'not a url', HA_TOKEN: 't' }), /full URL/);
});

test('numbers are validated instead of silently defaulting', () => {
  assert.throws(() => loadConfig({ SLIDE_INTERVAL_SECONDS: '0' }), /SLIDE_INTERVAL_SECONDS/);
  assert.throws(() => loadConfig({ IMMICH_PLAYLIST_SIZE: '5000' }), /IMMICH_PLAYLIST_SIZE/);
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
  assert.equal(loadConfig({ SLIDE_INTERVAL_SECONDS: ' 45 ' }).frame.intervalSeconds, 45);
});

test('booleans accept common spellings and reject nonsense', () => {
  assert.equal(loadConfig({ SHOW_CLOCK: 'off' }).frame.showClock, false);
  assert.equal(loadConfig({ SHOW_CLOCK: 'yes' }).frame.showClock, true);
  assert.equal(loadConfig({ IMMICH_FAVORITES_ONLY: 'true' }).immich.favoritesOnly, true);
  assert.throws(() => loadConfig({ SHOW_CLOCK: 'maybe' }), /SHOW_CLOCK/);
});

test('album ids must be UUIDs and entity ids must look like Home Assistant ids', () => {
  const config = loadConfig({ IMMICH_ALBUM_IDS: ` ${ALBUM_ID} , `, HA_ENTITIES: 'script.evening, cover.garage_door' });
  assert.deepEqual(config.immich.albumIds, [ALBUM_ID]);
  assert.deepEqual(config.homeAssistant.includeIds, ['script.evening', 'cover.garage_door']);
  assert.throws(() => loadConfig({ IMMICH_ALBUM_IDS: 'my-album' }), /album id/);
  assert.throws(() => loadConfig({ HA_ENTITIES: 'Light.Kitchen' }), /entity id/);
});

test('HA_ENTITIES adds to the discovered entities, and HA_HIDE_ENTITIES removes some', () => {
  const config = loadConfig({ HA_URL: 'http://ha.local:8123', HA_TOKEN: 't', HA_HIDE_ENTITIES: 'fan.bathroom' });
  assert.deepEqual(config.homeAssistant.includeIds, []);
  assert.deepEqual(config.homeAssistant.hideIds, ['fan.bathroom']);
  assert.throws(() => loadConfig({ HA_HIDE_ENTITIES: 'not-an-entity' }), /HA_HIDE_ENTITIES|entity id/);
});

test('PHOTO_FIT only accepts the known modes', () => {
  assert.equal(loadConfig({ PHOTO_FIT: 'Contain' }).frame.photoFit, 'contain');
  assert.throws(() => loadConfig({ PHOTO_FIT: 'stretch' }), /PHOTO_FIT/);
});

test('voice is off by default, and needs Home Assistant to be on', () => {
  const ha = { HA_URL: 'http://192.168.1.10:8123', HA_TOKEN: 't' };
  assert.equal(loadConfig(ha).homeAssistant.voice, false);
  assert.equal(loadConfig({ ...ha, HA_VOICE: 'true' }).homeAssistant.voice, true);
  assert.throws(() => loadConfig({ HA_VOICE: 'true' }), /HA_VOICE needs HA_URL and HA_TOKEN/);
  assert.throws(() => loadConfig({ ...ha, HA_VOICE: 'sometimes' }), /HA_VOICE/);
});

test('HA_VOICE_AGENT must look like a conversation agent id', () => {
  const voice = { HA_URL: 'http://192.168.1.10:8123', HA_TOKEN: 't', HA_VOICE: 'true' };
  assert.equal(loadConfig(voice).homeAssistant.voiceAgent, '');
  assert.equal(loadConfig({ ...voice, HA_VOICE_AGENT: ' conversation.openai ' }).homeAssistant.voiceAgent, 'conversation.openai');
  assert.equal(loadConfig({ ...voice, HA_VOICE_AGENT: '01JABCDEF0123456789XYZ' }).homeAssistant.voiceAgent, '01JABCDEF0123456789XYZ');
  assert.throws(() => loadConfig({ ...voice, HA_VOICE_AGENT: 'my agent' }), /HA_VOICE_AGENT/);
});
