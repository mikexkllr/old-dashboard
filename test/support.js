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

/** Builds a Home Assistant state object. */
export function haState(entityId, state, attributes = {}) {
  return {
    entity_id: entityId,
    state,
    attributes,
    last_changed: '2024-03-12T20:00:00+00:00',
    last_updated: '2024-03-12T20:00:00+00:00',
  };
}

/** Every entity type the dashboard has to cope with, including ones it must hide. */
export function defaultHaStates() {
  return [
    haState('light.kitchen', 'off', { friendly_name: 'Kitchen light', supported_color_modes: ['brightness'] }),
    haState('light.hall', 'on', { friendly_name: 'Hall lights', supported_color_modes: ['brightness'], brightness: 128 }),
    haState('light.bedside', 'on', { friendly_name: 'Bedside lamp', supported_color_modes: ['onoff'] }),
    haState('light.broken', 'unavailable', { friendly_name: 'Broken lamp', supported_color_modes: ['onoff'] }),
    haState('switch.coffee', 'on', { friendly_name: 'Coffee machine' }),
    haState('fan.bathroom', 'off', { friendly_name: 'Bathroom fan' }),
    haState('input_boolean.guest_mode', 'off', { friendly_name: 'Guest mode' }),
    haState('cover.living_room_blinds', 'closed', {
      friendly_name: 'Living room blinds',
      device_class: 'blind',
      current_position: 0,
    }),
    haState('cover.garage_door', 'closed', { friendly_name: 'Garage door', device_class: 'garage' }),
    haState('climate.living_room', 'heat', {
      friendly_name: 'Living room heating',
      temperature: 21.5,
      current_temperature: 20.8,
      min_temp: 7,
      max_temp: 30,
      target_temp_step: 0.5,
      temperature_unit: '°C',
    }),
    haState('climate.bedroom', 'heat_cool', { friendly_name: 'Bedroom climate' }),
    haState('scene.movie_night', '2024-03-12T20:00:00+00:00', { friendly_name: 'Movie night' }),
    haState('script.evening_routine', 'off', { friendly_name: 'Evening routine' }),
    haState('automation.night_mode', 'on', { friendly_name: 'Night mode' }),
    haState('button.restart_hub', 'unknown', { friendly_name: 'Restart hub' }),
    haState('group.all_lights', 'off', { friendly_name: 'All lights' }),
    haState('sensor.hall_temperature', '21.5', { friendly_name: 'Hall temperature', unit_of_measurement: '°C' }),
    haState('binary_sensor.front_door_contact', 'off', { friendly_name: 'Front door contact' }),
    haState('lock.front_door', 'locked', { friendly_name: 'Front door lock' }),
    haState('media_player.living_room_tv', 'playing', { friendly_name: 'Living room TV' }),
    haState('person.mike', 'home', { friendly_name: 'Mike' }),
    haState('sun.sun', 'above_horizon', { friendly_name: 'Sun' }),
  ];
}

/** Rooms as Home Assistant's template reports them. Entities listed nowhere have no room. */
export function defaultRooms() {
  return [
    { id: 'kitchen', name: 'Kitchen', entities: ['light.kitchen', 'light.broken'] },
    {
      id: 'living_room',
      name: 'Living room',
      entities: ['light.hall', 'cover.living_room_blinds', 'climate.living_room', 'media_player.living_room_tv', 'switch.coffee'],
    },
    { id: 'bedroom', name: 'Bedroom', entities: ['light.bedside', 'climate.bedroom'] },
  ];
}

// The service calls the mock understands, and what each one does to the state.
function applyService(current, rooms, domain, service, data) {
  const roomLights = data.area_id
    ? (rooms.find((room) => room.id === data.area_id)?.entities ?? []).filter((id) => id.startsWith('light.'))
    : null;
  const targets = data.entity_id ? [].concat(data.entity_id) : roomLights ?? [];

  for (const id of targets) {
    if (!current[id]) return { status: 400, body: { message: `Unknown entity ${id}` } };
  }

  for (const id of targets) {
    const entity = current[id];
    const attributes = entity.attributes;
    if (service === 'toggle') entity.state = entity.state === 'on' ? 'off' : 'on';
    if (domain === 'light' && service === 'turn_on') {
      entity.state = 'on';
      if (typeof data.brightness_pct === 'number') attributes.brightness = Math.round((data.brightness_pct * 255) / 100);
      else if (attributes.brightness === undefined) attributes.brightness = 255;
    }
    // A light switched on without a level comes on at full brightness, as Home Assistant does.
    if (domain === 'light' && service === 'toggle' && entity.state === 'on' && attributes.brightness === undefined) {
      attributes.brightness = 255;
    }
    if (domain === 'light' && service === 'turn_off') entity.state = 'off';
    if (domain === 'homeassistant' && service === 'turn_on') entity.state = 'on';
    if (domain === 'homeassistant' && service === 'turn_off') entity.state = 'off';
    if (domain === 'cover' && service === 'open_cover') {
      entity.state = 'open';
      attributes.current_position = 100;
    }
    if (domain === 'cover' && service === 'close_cover') {
      entity.state = 'closed';
      attributes.current_position = 0;
    }
    if (domain === 'climate' && service === 'set_temperature') attributes.temperature = data.temperature;
  }
  return { status: 200, body: [] };
}

// Home Assistant starts a conversation with a new ULID like this one.
export const CONVERSATION_ID = '01J9Z7K1M3S8TQ0Y6E4H2B5N7C';

// A small stand-in for Assist. It understands "turn on <name>" and "turn off
// <name>", and answers anything else the way Assist does when nothing matches.
function assist(current, { text, conversation_id: conversationId = CONVERSATION_ID }) {
  const reply = (responseType, speech, data) => ({
    response: {
      response_type: responseType,
      language: 'en',
      data,
      speech: { plain: { speech, extra_data: null } },
      card: {},
    },
    conversation_id: conversationId,
    continue_conversation: false,
  });
  const match = /^turn (on|off) (?:the )?(.+)$/i.exec(String(text).trim());
  const name = match?.[2].toLowerCase();
  const entity = Object.values(current).find((state) => state.attributes.friendly_name?.toLowerCase() === name);
  if (!entity) return reply('error', "Sorry, I couldn't understand that", { code: 'no_intent_match' });
  entity.state = match[1].toLowerCase();
  const target = { name: entity.attributes.friendly_name, type: 'entity', id: entity.entity_id };
  return reply('action_done', `Turned ${entity.state} ${target.name}`, { success: [target], failed: [] });
}

/**
 * A stand-in for Home Assistant. It keeps its own state, applies the services
 * it receives and records every request, so tests can check what really changed.
 */
export async function startHomeAssistant({
  states = defaultHaStates(),
  rooms = defaultRooms(),
  agents = ['conversation.home_assistant'],
  failRooms = false,
  failStates = false,
} = {}) {
  const calls = [];
  const current = Object.fromEntries(structuredClone(states).map((state) => [state.entity_id, state]));

  const mock = await listen(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const body = await readBody(req);
    calls.push({ method: req.method, path: url.pathname, body, authorization: req.headers.authorization });

    if (req.headers.authorization !== `Bearer ${HA_TOKEN}`) {
      return json(res, 401, { message: 'Invalid access token or password' });
    }

    if (req.method === 'GET' && url.pathname === '/api/states') {
      if (failStates) return json(res, 500, { message: 'broken on purpose' });
      return json(res, 200, Object.values(current));
    }

    const state = /^\/api\/states\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && state) {
      return current[state[1]] ? json(res, 200, current[state[1]]) : json(res, 404, { message: 'Entity not found.' });
    }

    if (req.method === 'POST' && url.pathname === '/api/template') {
      if (failRooms) return json(res, 500, { message: 'template broken on purpose' });
      const { template = '' } = JSON.parse(body || '{}');
      if (!template.includes('areas()')) return json(res, 400, { message: 'Unsupported template in this mock' });
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(rooms.map((room) => `${room.id}|${room.name}|${room.entities.join(',')}\n`).join(''));
    }

    const service = /^\/api\/services\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'POST' && service) {
      const result = applyService(current, rooms, service[1], service[2], JSON.parse(body || '{}'));
      return json(res, result.status, result.body);
    }

    if (req.method === 'POST' && url.pathname === '/api/conversation/process') {
      const request = JSON.parse(body || '{}');
      if (request.agent_id !== undefined && !agents.includes(request.agent_id)) {
        return json(res, 400, { message: 'Message format incorrect: invalid agent ID' });
      }
      return json(res, 200, assist(current, request));
    }

    return json(res, 404, { message: 'Unknown route' });
  });

  return { ...mock, calls, states: current, close: () => closeServer(mock.server) };
}

/** Starts the dashboard against whatever upstreams the env points at. */
export async function startDashboard(env, { now } = {}) {
  const config = loadConfig(env);
  const immich = createImmichClient(config.immich);
  const homeAssistant = createHomeAssistantClient({
    ...config.homeAssistant,
    now,
    logger: { warn() {} },
  });
  const server = createApp({ config, immich, homeAssistant, logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => closeServer(server) };
}
