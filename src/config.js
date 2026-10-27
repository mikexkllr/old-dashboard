import { isEntityId } from './homeassistant.js';
import { isUuid, MAX_YEAR, MIN_YEAR, PHOTO_FIT_MODES } from './settings.js';

function text(env, name, fallback = '') {
  const value = env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function integer(env, name, fallback, max, min = 1) {
  const raw = text(env, name);
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max} (got "${raw}")`);
  }
  return value;
}

function boolean(env, name, fallback) {
  const raw = text(env, name).toLowerCase();
  if (raw === '') return fallback;
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be true or false (got "${raw}")`);
}

function list(env, name, isValid, description) {
  const items = text(env, name)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const invalid = items.find((item) => !isValid(item));
  if (invalid !== undefined) throw new Error(`${name} contains an invalid ${description}: "${invalid}"`);
  return items;
}

function httpUrl(env, name) {
  const raw = text(env, name);
  if (raw === '') return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be a full URL such as http://192.168.1.10:8123 (got "${raw}")`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must start with http:// or https://`);
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

/**
 * Reads settings from environment variables. Photos and Home Assistant are
 * optional, but each needs its URL and secret together, so a half-filled pair
 * fails at startup instead of silently doing nothing. The frame and photo
 * settings are defaults that the settings menu can change.
 */
export function loadConfig(env = process.env) {
  const immichUrl = httpUrl(env, 'IMMICH_URL').replace(/\/api$/, '');
  const immichKey = text(env, 'IMMICH_API_KEY');
  if (Boolean(immichUrl) !== Boolean(immichKey)) {
    throw new Error('Set both IMMICH_URL and IMMICH_API_KEY to show photos, or leave both empty');
  }

  const haUrl = httpUrl(env, 'HA_URL');
  const haToken = text(env, 'HA_TOKEN');
  if (Boolean(haUrl) !== Boolean(haToken)) {
    throw new Error('Set both HA_URL and HA_TOKEN to enable Home Assistant, or leave both empty');
  }

  const photoFit = text(env, 'PHOTO_FIT', 'auto').toLowerCase();
  if (!PHOTO_FIT_MODES.includes(photoFit)) {
    throw new Error(`PHOTO_FIT must be one of ${PHOTO_FIT_MODES.join(', ')}`);
  }

  const fromYear = integer(env, 'IMMICH_FROM_YEAR', null, MAX_YEAR, MIN_YEAR);
  const toYear = integer(env, 'IMMICH_TO_YEAR', null, MAX_YEAR, MIN_YEAR);
  if (fromYear !== null && toYear !== null && fromYear > toYear) {
    throw new Error(`IMMICH_FROM_YEAR (${fromYear}) must not be after IMMICH_TO_YEAR (${toYear})`);
  }

  return {
    port: integer(env, 'PORT', 3000, 65535),
    // Where the settings menu keeps its changes. Empty keeps them in memory only.
    settingsFile: text(env, 'SETTINGS_FILE'),
    frame: {
      intervalSeconds: integer(env, 'SLIDE_INTERVAL_SECONDS', 60, 3600),
      photoFit,
      showClock: boolean(env, 'SHOW_CLOCK', true),
      showCaptions: boolean(env, 'SHOW_CAPTIONS', true),
      panelIdleSeconds: integer(env, 'PANEL_IDLE_SECONDS', 60, 3600),
    },
    immich: {
      url: immichUrl,
      apiKey: immichKey,
      albumIds: list(env, 'IMMICH_ALBUM_IDS', isUuid, 'album id (expected a UUID)'),
      personIds: list(env, 'IMMICH_PERSON_IDS', isUuid, 'person id (expected a UUID)'),
      favoritesOnly: boolean(env, 'IMMICH_FAVORITES_ONLY', false),
      fromYear,
      toYear,
      playlistSize: integer(env, 'IMMICH_PLAYLIST_SIZE', 200, 1000),
    },
    homeAssistant: {
      url: haUrl,
      token: haToken,
      // Extra entities to show and control, such as scripts, automations and garage doors.
      includeIds: list(env, 'HA_ENTITIES', isEntityId, 'entity id (expected something like script.evening_routine)'),
      hideIds: list(env, 'HA_HIDE_ENTITIES', isEntityId, 'entity id (expected something like sensor.router_uptime)'),
    },
  };
}
