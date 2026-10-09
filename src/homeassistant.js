import { HttpError } from './errors.js';

const ENTITY_ID = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const ON_STATES = new Set(['on', 'open', 'opening']);
const UNAVAILABLE_STATES = new Set(['unavailable', 'unknown']);
const REQUEST_TIMEOUT_MS = 10_000;

// What the dashboard may do to each domain. Anything not listed here is
// display-only, so locks, alarms and media players stay out of reach.
const CONTROLS = new Map([
  ['light', { kind: 'toggle', service: 'toggle' }],
  ['switch', { kind: 'toggle', service: 'toggle' }],
  ['input_boolean', { kind: 'toggle', service: 'toggle' }],
  ['fan', { kind: 'toggle', service: 'toggle' }],
  ['automation', { kind: 'toggle', service: 'toggle' }],
  ['cover', { kind: 'toggle', service: 'toggle' }],
  ['scene', { kind: 'press', service: 'turn_on' }],
  ['script', { kind: 'press', service: 'turn_on' }],
  ['button', { kind: 'press', service: 'press' }],
  ['input_button', { kind: 'press', service: 'press' }],
]);

export function isEntityId(value) {
  return typeof value === 'string' && ENTITY_ID.test(value);
}

function domainOf(entityId) {
  return entityId.split('.')[0];
}

export function createHomeAssistantClient({
  url = '',
  token = '',
  entityIds = [],
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const enabled = Boolean(url && token);

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

  async function readState(entityId) {
    try {
      const res = await send(`/api/states/${entityId}`);
      if (!res.ok) {
        await res.arrayBuffer().catch(() => {});
        return { error: res.status === 404 ? 'Not found in Home Assistant' : `Home Assistant returned HTTP ${res.status}` };
      }
      return await res.json();
    } catch (err) {
      return { error: err.message };
    }
  }

  function toEntity(entityId, state) {
    const domain = domainOf(entityId);
    const kind = CONTROLS.get(domain)?.kind ?? 'info';
    const name = state.attributes?.friendly_name ?? entityId;

    if (state.error || typeof state.state !== 'string') {
      return {
        entity_id: entityId,
        name,
        domain,
        kind,
        state: 'unavailable',
        unit: null,
        on: false,
        available: false,
        error: state.error ?? 'No state reported',
      };
    }

    return {
      entity_id: entityId,
      name,
      domain,
      kind,
      state: state.state,
      unit: state.attributes?.unit_of_measurement ?? null,
      on: ON_STATES.has(state.state),
      available: !UNAVAILABLE_STATES.has(state.state),
    };
  }

  async function getEntities() {
    return Promise.all(entityIds.map(async (entityId) => toEntity(entityId, await readState(entityId))));
  }

  async function runAction(entityId) {
    if (!isEntityId(entityId)) throw new HttpError(400, 'Invalid entity id');
    if (!entityIds.includes(entityId)) throw new HttpError(403, `${entityId} is not listed in HA_ENTITIES`);

    const domain = domainOf(entityId);
    const control = CONTROLS.get(domain);
    if (!control) throw new HttpError(400, `The dashboard cannot control ${domain} entities`);

    const res = await send(`/api/services/${domain}/${control.service}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entity_id: entityId }),
    });
    await res.arrayBuffer().catch(() => {});
    if (res.status === 401) throw new HttpError(502, 'Home Assistant rejected the access token. Check HA_TOKEN.');
    if (!res.ok) throw new HttpError(502, `Home Assistant returned HTTP ${res.status} for ${domain}.${control.service}`);

    return toEntity(entityId, await readState(entityId));
  }

  return { enabled, getEntities, runAction };
}
