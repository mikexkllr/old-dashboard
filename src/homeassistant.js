import { HttpError } from './errors.js';

const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const AREA_ID = /^[a-z0-9_]+$/;
const REQUEST_TIMEOUT_MS = 10_000;
const STATES_TTL_MS = 2_000; // one entity list serves every panel poll in this window
const ROOMS_TTL_MS = 60_000; // room layout changes rarely

export const COMMANDS = new Set(['toggle', 'brightness', 'run', 'open', 'stop', 'close', 'temperature']);

// Renders one "id|name|entity,entity" line per room (area).
export const ROOMS_TEMPLATE =
  "{% for area in areas() %}{{ area }}|{{ area_name(area) }}|{{ area_entities(area) | join(',') }}\n{% endfor %}";

const CATEGORY_ORDER = ['lights', 'covers', 'switches', 'scenes', 'climate', 'status'];

const CATEGORY_BY_DOMAIN = new Map([
  ['light', 'lights'],
  ['cover', 'covers'],
  ['switch', 'switches'],
  ['fan', 'switches'],
  ['input_boolean', 'switches'],
  ['automation', 'switches'],
  ['group', 'switches'],
  ['climate', 'climate'],
  ['scene', 'scenes'],
  ['script', 'scenes'],
  ['button', 'scenes'],
  ['input_button', 'scenes'],
]);

// Internal domains that never belong on a wall panel.
const NOISE_DOMAINS = new Set([
  'ai_task', 'assist_satellite', 'calendar', 'camera', 'conversation', 'device_tracker', 'event', 'image',
  'notify', 'person', 'persistent_notification', 'stt', 'sun', 'tag', 'todo', 'tts', 'update', 'wake_word',
  'weather', 'zone',
]);

// These appear only when listed in HA_ENTITIES, because they can run arbitrary
// actions or open things. Covers for doors, garages and gates are treated the same way.
const OPT_IN_DOMAINS = new Set(['automation', 'button', 'group', 'input_button', 'script']);
const PROTECTED_COVER_CLASSES = new Set(['door', 'garage', 'gate']);

const TOGGLE_DOMAINS = new Set(['automation', 'fan', 'input_boolean', 'light', 'switch']);
const RUN_SERVICES = new Map([
  ['scene', ['scene', 'turn_on']],
  ['script', ['script', 'turn_on']],
  ['button', ['button', 'press']],
  ['input_button', ['input_button', 'press']],
]);

const ON_STATES = new Set(['on', 'open', 'opening']);
const UNAVAILABLE_STATES = new Set(['unavailable', 'unknown']);

export function isEntityId(value) {
  return typeof value === 'string' && ENTITY_ID.test(value);
}

function domainOf(entityId) {
  return entityId.split('.')[0];
}

function isDimmable(attributes) {
  if (Array.isArray(attributes.supported_color_modes)) {
    return attributes.supported_color_modes.some((mode) => mode !== 'onoff');
  }
  return typeof attributes.brightness === 'number';
}

// Percent of full brightness. An off light is always 0, even if it still carries
// a stale brightness value. A light that is on without a reported level gets null,
// so the panel never shows a level Home Assistant did not give.
export function brightnessLevel(stateValue, attributes) {
  if (stateValue !== 'on') return 0;
  if (typeof attributes.brightness === 'number') return Math.round((attributes.brightness * 100) / 255);
  return null;
}

function commandsFor(domain, state) {
  const attributes = state.attributes ?? {};
  if (domain === 'light') return isDimmable(attributes) ? ['toggle', 'brightness'] : ['toggle'];
  if (TOGGLE_DOMAINS.has(domain) || domain === 'group') return ['toggle'];
  if (domain === 'cover') return ['open', 'stop', 'close'];
  if (domain === 'climate') return typeof attributes.temperature === 'number' ? ['temperature'] : [];
  if (RUN_SERVICES.has(domain)) return ['run'];
  return [];
}

/**
 * Decides whether the dashboard shows an entity, and what it may do with it.
 * Returns null when the entity should not appear at all.
 */
export function classify(state, { included = new Set(), hidden = new Set() } = {}) {
  const entityId = state.entity_id;
  if (hidden.has(entityId)) return null;

  const domain = domainOf(entityId);
  const listed = included.has(entityId);
  if (!listed && NOISE_DOMAINS.has(domain)) return null;

  const attributes = state.attributes ?? {};
  const optIn = OPT_IN_DOMAINS.has(domain)
    || (domain === 'cover' && PROTECTED_COVER_CLASSES.has(attributes.device_class));
  if (optIn && !listed) return null;

  return {
    category: CATEGORY_BY_DOMAIN.get(domain) ?? 'status',
    commands: commandsFor(domain, state),
  };
}

function climateInfo(attributes) {
  const unit = attributes.temperature_unit ?? '°C';
  const fahrenheit = unit === '°F';
  return {
    target: attributes.temperature,
    current: typeof attributes.current_temperature === 'number' ? attributes.current_temperature : null,
    min: typeof attributes.min_temp === 'number' ? attributes.min_temp : (fahrenheit ? 45 : 7),
    max: typeof attributes.max_temp === 'number' ? attributes.max_temp : (fahrenheit ? 95 : 35),
    step: typeof attributes.target_temp_step === 'number' ? attributes.target_temp_step : (fahrenheit ? 1 : 0.5),
    unit,
  };
}

function toEntity(state, description, area) {
  const attributes = state.attributes ?? {};
  const { commands } = description;
  return {
    entity_id: state.entity_id,
    name: attributes.friendly_name ?? state.entity_id,
    domain: domainOf(state.entity_id),
    category: description.category,
    area_id: area?.id ?? null,
    area: area?.name ?? null,
    state: state.state,
    unit: attributes.unit_of_measurement ?? null,
    available: !UNAVAILABLE_STATES.has(state.state),
    on: ON_STATES.has(state.state),
    commands,
    brightness: commands.includes('brightness') ? brightnessLevel(state.state, attributes) : null,
    position: typeof attributes.current_position === 'number' ? attributes.current_position : null,
    climate: commands.includes('temperature') ? climateInfo(attributes) : null,
  };
}

export function describeEntity(state, { areas = new Map(), included = new Set(), hidden = new Set() } = {}) {
  const description = classify(state, { included, hidden });
  return description ? toEntity(state, description, areas.get(state.entity_id) ?? null) : null;
}

function byRoomThenCategoryThenName(a, b) {
  if (a.area !== b.area) {
    if (a.area === null) return 1;
    if (b.area === null) return -1;
    return a.area.localeCompare(b.area);
  }
  const rank = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
  if (rank !== 0) return rank;
  return a.name.localeCompare(b.name);
}

export function buildControls({ states, areas = new Map(), included = new Set(), hidden = new Set() }) {
  const known = new Set(states.map((state) => state.entity_id));
  const entities = [];
  for (const state of states) {
    const entity = describeEntity(state, { areas, included, hidden });
    if (entity) entities.push(entity);
  }
  entities.sort(byRoomThenCategoryThenName);
  const missing = [...included].filter((entityId) => !known.has(entityId)).sort();
  return { entities, missing };
}

/** Parses the output of ROOMS_TEMPLATE. Each entity is assigned to the first room that lists it. */
export function parseRooms(text) {
  const rooms = [];
  const byEntity = new Map();
  for (const line of String(text).split('\n')) {
    const row = line.trim();
    const first = row.indexOf('|');
    const last = row.lastIndexOf('|');
    if (first <= 0 || last === first) continue;

    const id = row.slice(0, first).trim();
    if (!AREA_ID.test(id)) continue;
    const room = { id, name: row.slice(first + 1, last).trim() || id };
    rooms.push(room);

    for (const entityId of row.slice(last + 1).split(',')) {
      const trimmed = entityId.trim();
      if (trimmed && !byEntity.has(trimmed)) byEntity.set(trimmed, room);
    }
  }
  return { rooms, byEntity };
}

/** The Home Assistant service that carries out a command, or null when none applies. */
export function serviceFor(entity, command, value) {
  const data = { entity_id: entity.entity_id };
  switch (command) {
    case 'toggle':
      if (entity.domain === 'group') {
        return { domain: 'homeassistant', service: entity.on ? 'turn_off' : 'turn_on', data };
      }
      return TOGGLE_DOMAINS.has(entity.domain) ? { domain: entity.domain, service: 'toggle', data } : null;
    case 'brightness':
      if (value === 0) return { domain: 'light', service: 'turn_off', data };
      return { domain: 'light', service: 'turn_on', data: { ...data, brightness_pct: value } };
    case 'run': {
      const run = RUN_SERVICES.get(entity.domain);
      return run ? { domain: run[0], service: run[1], data } : null;
    }
    case 'open':
      return { domain: 'cover', service: 'open_cover', data };
    case 'close':
      return { domain: 'cover', service: 'close_cover', data };
    case 'stop':
      return { domain: 'cover', service: 'stop_cover', data };
    case 'temperature':
      return { domain: 'climate', service: 'set_temperature', data: { ...data, temperature: value } };
    default:
      return null;
  }
}

/** Checks the value a command carries. Returns the value to send, or throws HttpError(400). */
export function normalizeValue(entity, command, value) {
  if (command === 'brightness') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new HttpError(400, 'Brightness must be a number from 0 to 100');
    }
    return Math.round(value);
  }
  if (command === 'temperature') {
    const { min, max } = entity.climate;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw new HttpError(400, `Temperature must be a number from ${min} to ${max}`);
    }
    return Math.round(value * 10) / 10;
  }
  if (value !== undefined && value !== null) {
    throw new HttpError(400, `"${command}" does not take a value`);
  }
  return undefined;
}

// Shares one in-flight request between callers and reuses its result for ttlMs.
// Failed requests are not kept, so the next caller tries again. invalidate()
// drops the result, so the next caller reads fresh data after a change.
function ttlCache(ttlMs, now, load) {
  let entry = null;
  const cached = function cached() {
    const current = now();
    if (entry && current - entry.at < ttlMs) return entry.promise;
    const created = { at: current, promise: load() };
    entry = created;
    created.promise.catch(() => {
      if (entry === created) entry = null;
    });
    return created.promise;
  };
  cached.invalidate = () => {
    entry = null;
  };
  return cached;
}

export function createHomeAssistantClient({
  url = '',
  token = '',
  includeIds = [],
  hideIds = [],
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  now = Date.now,
  logger = console,
} = {}) {
  const enabled = Boolean(url && token);
  const included = new Set(includeIds);
  const hidden = new Set(hideIds);
  let lastRooms = null;

  async function send(apiPath, init = {}) {
    try {
      return await fetchImpl(`${url}${apiPath}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...init.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new HttpError(502, `Cannot reach Home Assistant (${err.cause?.code ?? err.name}). Check HA_URL.`);
    }
  }

  async function drain(res) {
    await res.arrayBuffer().catch(() => {});
  }

  function statusError(status, what) {
    if (status === 401) return new HttpError(502, 'Home Assistant rejected the access token. Check HA_TOKEN.');
    return new HttpError(502, `Home Assistant returned HTTP ${status} for ${what}`);
  }

  async function readJson(res, what) {
    try {
      return await res.json();
    } catch {
      throw new HttpError(502, `Home Assistant sent an unreadable reply for ${what}`);
    }
  }

  const cachedStates = ttlCache(STATES_TTL_MS, now, async () => {
    const res = await send('/api/states');
    if (!res.ok) {
      await drain(res);
      throw statusError(res.status, 'the entity list');
    }
    const states = await readJson(res, 'the entity list');
    if (!Array.isArray(states)) throw new HttpError(502, 'Home Assistant sent an unexpected entity list');
    return states;
  });

  // Rooms are optional. If they cannot be read, the panel still works and
  // lists everything under "No room". The last good answer is kept.
  const cachedRooms = ttlCache(ROOMS_TTL_MS, now, async () => {
    try {
      const res = await send('/api/template', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ template: ROOMS_TEMPLATE }),
      });
      if (!res.ok) {
        await drain(res);
        throw statusError(res.status, 'the room list');
      }
      lastRooms = { available: true, ...parseRooms(await res.text()) };
    } catch (err) {
      logger.warn(`Could not load rooms from Home Assistant: ${err.message}`);
      lastRooms = lastRooms ?? { available: false, rooms: [], byEntity: new Map() };
    }
    return lastRooms;
  });

  async function readState(entityId) {
    const res = await send(`/api/states/${entityId}`);
    if (res.status === 404) {
      await drain(res);
      return null;
    }
    if (!res.ok) {
      await drain(res);
      throw statusError(res.status, entityId);
    }
    return readJson(res, entityId);
  }

  async function callService({ domain, service, data }) {
    const res = await send(`/api/services/${domain}/${service}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      await drain(res);
      throw statusError(res.status, `${domain}.${service}`);
    }
    await drain(res);
  }

  async function getControls() {
    const [states, rooms] = await Promise.all([cachedStates(), cachedRooms()]);
    const { entities, missing } = buildControls({ states, areas: rooms.byEntity, included, hidden });
    return { configured: true, areasAvailable: rooms.available, entities, missing };
  }

  async function runCommand(entityId, command, value) {
    if (!isEntityId(entityId)) throw new HttpError(400, 'Invalid entity id');
    if (!COMMANDS.has(command)) throw new HttpError(400, `Unknown command "${command}"`);

    // Read the entity fresh, so the allowed commands match what Home Assistant reports now.
    const state = await readState(entityId);
    if (!state) throw new HttpError(404, `${entityId} was not found in Home Assistant`);
    const rooms = await cachedRooms();
    const options = { areas: rooms.byEntity, included, hidden };

    const entity = describeEntity(state, options);
    if (!entity) throw new HttpError(403, `${entityId} is not controllable from the dashboard`);
    if (!entity.available) throw new HttpError(400, `${entityId} is unavailable`);
    if (!entity.commands.includes(command)) throw new HttpError(400, `${entityId} cannot "${command}"`);

    const service = serviceFor(entity, command, normalizeValue(entity, command, value));
    if (!service) throw new HttpError(400, `${entityId} cannot "${command}"`);
    await callService(service);
    cachedStates.invalidate();

    const updated = await readState(entityId);
    return describeEntity(updated ?? state, options) ?? entity;
  }

  // Turns off the lights the panel shows in the room. Naming them, rather than
  // sending the area, keeps lights in HA_HIDE_ENTITIES out of it.
  async function lightsOffInArea(areaId) {
    if (!AREA_ID.test(areaId)) throw new HttpError(400, 'Invalid room id');
    const [states, rooms] = await Promise.all([cachedStates(), cachedRooms()]);
    if (!rooms.rooms.some((room) => room.id === areaId)) throw new HttpError(404, 'Room not found');
    const { entities } = buildControls({ states, areas: rooms.byEntity, included, hidden });
    const lights = entities
      .filter((entity) => entity.area_id === areaId && entity.domain === 'light')
      .map((entity) => entity.entity_id);
    if (lights.length === 0) return;
    await callService({ domain: 'light', service: 'turn_off', data: { entity_id: lights } });
    cachedStates.invalidate();
  }

  return { enabled, getControls, runCommand, lightsOffInArea };
}
