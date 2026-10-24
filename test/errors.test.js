import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localNameHint } from '../src/errors.js';
import { createHomeAssistantClient } from '../src/homeassistant.js';
import { createImmichClient } from '../src/immich.js';

// Fails the way Node's fetch does when a name cannot be looked up, so these
// tests never depend on how the machine running them resolves .local names.
function unresolvable() {
  const cause = Object.assign(new Error('getaddrinfo ENOTFOUND umbrel.local'), { code: 'ENOTFOUND' });
  throw new TypeError('fetch failed', { cause });
}

test('only .local names get the advice to use an IP address', () => {
  assert.match(localNameHint('HA_URL', 'http://umbrel.local:8123'), /HA_URL uses umbrel\.local.*http:\/\/192\.168\.1\.10:8123/);
  assert.match(localNameHint('IMMICH_URL', 'http://Umbrel.LOCAL'), /http:\/\/192\.168\.1\.10\.$/);
  assert.equal(localNameHint('HA_URL', 'http://192.168.1.10:8123'), null);
  assert.equal(localNameHint('HA_URL', 'http://homeassistant.lan:8123'), null);
  assert.equal(localNameHint('HA_URL', ''), null);
});

test('a .local Home Assistant URL that cannot be reached says why', async () => {
  const client = createHomeAssistantClient({
    url: 'http://umbrel.local:8123',
    token: 'token',
    fetchImpl: unresolvable,
    logger: { warn() {} },
  });
  await assert.rejects(client.getControls(), (err) => {
    assert.equal(err.status, 502);
    assert.match(err.message, /^Cannot reach Home Assistant \(ENOTFOUND\)\. HA_URL uses umbrel\.local/);
    assert.match(err.message, /can't resolve \.local names/);
    return true;
  });
});

test('a .local Immich URL that cannot be reached says why', async () => {
  const client = createImmichClient({ url: 'http://umbrel.local:2283', apiKey: 'key', fetchImpl: unresolvable });
  await assert.rejects(client.getPlaylist(), (err) => {
    assert.equal(err.status, 502);
    assert.match(err.message, /^Cannot reach Immich \(ENOTFOUND\)\. IMMICH_URL uses umbrel\.local/);
    return true;
  });
});

test('other unreachable URLs keep the plain advice', async () => {
  const client = createImmichClient({ url: 'http://10.0.0.5:2283', apiKey: 'key', fetchImpl: unresolvable });
  await assert.rejects(client.getPlaylist(), /Cannot reach Immich \(ENOTFOUND\)\. Check IMMICH_URL\.$/);
});
