import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './errors.js';
import { isEntityId } from './homeassistant.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PHOTO_FIT_MODES = ['auto', 'cover', 'contain'];
export const MIN_YEAR = 1900;
export const MAX_YEAR = 2100;

export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

function integerField(min, max) {
  return (value, name) => {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be a whole number from ${min} to ${max}`);
    }
    return value;
  };
}

function yearField() {
  const year = integerField(MIN_YEAR, MAX_YEAR);
  return (value, name) => (value === null ? null : year(value, name));
}

function booleanField() {
  return (value, name) => {
    if (typeof value !== 'boolean') throw new Error(`${name} must be true or false`);
    return value;
  };
}

function oneOf(values) {
  return (value, name) => {
    if (!values.includes(value)) throw new Error(`${name} must be one of ${values.join(', ')}`);
    return value;
  };
}

function idList(isValid, description, max) {
  return (value, name) => {
    if (!Array.isArray(value) || value.length > max) {
      throw new Error(`${name} must be a list of up to ${max} ${description}s`);
    }
    const invalid = value.find((item) => !isValid(item));
    if (invalid !== undefined) {
      throw new Error(`${name} contains an invalid ${description}: ${JSON.stringify(invalid).slice(0, 80)}`);
    }
    return [...new Set(value)];
  };
}

// What the settings menu can change. The environment variables give the
// defaults, and a value chosen in the menu replaces its default.
const FIELDS = {
  intervalSeconds: integerField(1, 3600),
  photoFit: oneOf(PHOTO_FIT_MODES),
  showClock: booleanField(),
  showCaptions: booleanField(),
  panelIdleSeconds: integerField(1, 3600),
  albumIds: idList(isUuid, 'album id', 500),
  personIds: idList(isUuid, 'person id', 500),
  favoritesOnly: booleanField(),
  fromYear: yearField(),
  toYear: yearField(),
  hiddenEntities: idList(isEntityId, 'entity id', 2000),
};

export const SETTING_NAMES = Object.keys(FIELDS);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function yearRangeProblem({ fromYear, toYear }) {
  if (fromYear !== null && toYear !== null && fromYear > toYear) {
    return `The from year (${fromYear}) is after the until year (${toYear})`;
  }
  return null;
}

/** The defaults for every setting, taken from the environment configuration. */
export function settingsDefaults(config) {
  return {
    ...config.frame,
    albumIds: config.immich.albumIds,
    personIds: config.immich.personIds,
    favoritesOnly: config.immich.favoritesOnly,
    fromYear: config.immich.fromYear,
    toYear: config.immich.toYear,
    // HA_HIDE_ENTITIES always applies. These are hidden on top of it.
    hiddenEntities: [],
  };
}

/**
 * Keeps the settings chosen in the menu. Only the ones that differ from their
 * defaults are stored, in a JSON file when `file` is set. When the file cannot
 * be written, changes still apply until the server restarts, and `problem`
 * says why they will not last.
 */
export function createSettingsStore({ defaults, file = '', logger = console }) {
  let overrides = {};
  let revision = 0;
  let problem = file ? null : 'Settings last until the server restarts, because SETTINGS_FILE is not set.';
  let writes = Promise.resolve();

  function current() {
    return { ...defaults, ...overrides };
  }

  function accept(target, key, value) {
    const normalized = FIELDS[key](value, key);
    if (sameValue(normalized, defaults[key])) {
      delete target[key];
    } else {
      target[key] = normalized;
    }
  }

  async function load() {
    if (!file) return;
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') logger.warn(`Could not read ${file} (${err.code ?? err.message}), so the default settings apply`);
      return;
    }

    let stored;
    try {
      stored = JSON.parse(text);
    } catch {
      logger.warn(`Ignoring ${file}, because it is not valid JSON`);
      return;
    }
    const saved = isPlainObject(stored) && isPlainObject(stored.settings) ? stored.settings : {};
    const loaded = {};
    for (const [key, value] of Object.entries(saved)) {
      if (!Object.hasOwn(FIELDS, key)) {
        logger.warn(`Ignoring the unknown setting "${key}" in ${file}`);
        continue;
      }
      try {
        accept(loaded, key, value);
      } catch (err) {
        logger.warn(`Ignoring a setting in ${file}: ${err.message}`);
      }
    }
    // An environment change can turn a saved year into an impossible range.
    const range = yearRangeProblem({ ...defaults, ...loaded });
    if (range) {
      logger.warn(`Ignoring the saved years in ${file}: ${range}`);
      delete loaded.fromYear;
      delete loaded.toYear;
    }
    overrides = loaded;
  }

  async function save(snapshot) {
    const temporary = `${file}.tmp`;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(temporary, `${JSON.stringify({ version: 1, settings: snapshot }, null, 2)}\n`);
    await rename(temporary, file);
  }

  // Writes one at a time, in order, so the file always ends with the latest settings.
  function persist() {
    if (!file) return Promise.resolve();
    const snapshot = { ...overrides };
    writes = writes.then(() => save(snapshot)).then(
      () => {
        problem = null;
      },
      (err) => {
        problem = `Settings apply now, but are lost when the server restarts: cannot write ${file} (${err.code ?? err.message}).`;
        logger.warn(problem);
      },
    );
    return writes;
  }

  function state() {
    return {
      settings: current(),
      defaults,
      changed: Object.keys(overrides),
      revision,
      saved: problem === null,
      problem,
    };
  }

  /** Applies a partial update. Every value is checked before anything changes. */
  async function update(patch) {
    if (!isPlainObject(patch)) throw new HttpError(400, 'Settings must be a JSON object');
    const next = { ...overrides };
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.hasOwn(FIELDS, key)) throw new HttpError(400, `Unknown setting "${key}"`);
      try {
        accept(next, key, value);
      } catch (err) {
        throw new HttpError(400, err.message);
      }
    }
    const range = yearRangeProblem({ ...defaults, ...next });
    if (range) throw new HttpError(400, range);

    overrides = next;
    revision += 1;
    await persist();
    return state();
  }

  /** Forgets every change made in the menu, so the environment values apply again. */
  async function reset() {
    overrides = {};
    revision += 1;
    await persist();
    return state();
  }

  return { load, current, state, update, reset, get revision() { return revision; } };
}
