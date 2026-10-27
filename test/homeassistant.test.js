import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildControls,
  classify,
  describeEntity,
  lightGroupServices,
  normalizeValue,
  parseRooms,
  ROOMS_TEMPLATE,
  serviceFor,
} from '../src/homeassistant.js';
import { haState } from './support.js';

test('the room template uses Home Assistant template functions for areas and their entities', () => {
  assert.match(ROOMS_TEMPLATE, /areas\(\)/);
  assert.match(ROOMS_TEMPLATE, /area_name\(area\)/);
  assert.match(ROOMS_TEMPLATE, /area_entities\(area\) \| join/);
});

test('parses room lines, keeping room names that contain a pipe', () => {
  const { rooms, byEntity } = parseRooms(
    'kitchen|Kitchen|light.kitchen,light.broken\nstudy|Office | Desk|switch.desk\nempty|Empty|\n',
  );
  assert.deepEqual(rooms.map((room) => room.id), ['kitchen', 'study', 'empty']);
  assert.equal(rooms[1].name, 'Office | Desk');
  assert.equal(byEntity.get('light.broken').id, 'kitchen');
  assert.equal(byEntity.get('switch.desk').name, 'Office | Desk');
});

test('ignores malformed room lines and gives each entity to the first room that lists it', () => {
  const { rooms, byEntity } = parseRooms(
    'not a room\n|nameless|light.x\nkitchen|Kitchen|light.a\nhall|Hall|light.a,light.b\n',
  );
  assert.deepEqual(rooms.map((room) => room.id), ['kitchen', 'hall']);
  assert.equal(byEntity.get('light.a').id, 'kitchen');
  assert.equal(byEntity.get('light.b').id, 'hall');
  assert.equal(byEntity.has('light.x'), false);
});

test('lights, switches, covers, scenes, climate and sensors are shown by default', () => {
  assert.equal(classify(haState('light.kitchen', 'off', {})).category, 'lights');
  assert.equal(classify(haState('switch.coffee', 'on', {})).category, 'switches');
  assert.equal(classify(haState('fan.bathroom', 'off', {})).category, 'switches');
  assert.equal(classify(haState('input_boolean.guest', 'off', {})).category, 'switches');
  assert.equal(classify(haState('cover.blinds', 'closed', { device_class: 'blind' })).category, 'covers');
  assert.equal(classify(haState('scene.movie', 'x', {})).category, 'scenes');
  assert.equal(classify(haState('climate.hall', 'heat', { temperature: 20 })).category, 'climate');
  assert.equal(classify(haState('sensor.temp', '21', {})).category, 'status');
  assert.equal(classify(haState('lock.front', 'locked', {})).category, 'status');
});

test('scripts, automations, buttons and groups stay hidden unless they are listed', () => {
  for (const entityId of ['script.x', 'automation.x', 'button.x', 'input_button.x', 'group.x']) {
    const state = haState(entityId, 'on', {});
    assert.equal(classify(state), null, `${entityId} should be hidden by default`);
    assert.notEqual(classify(state, { included: new Set([entityId]) }), null, `${entityId} should show when listed`);
  }
});

test('covers for doors, garages and gates stay hidden unless they are listed', () => {
  const garage = haState('cover.garage', 'closed', { device_class: 'garage' });
  assert.equal(classify(garage), null);
  const listed = classify(garage, { included: new Set(['cover.garage']) });
  assert.equal(listed.category, 'covers');
  assert.deepEqual(listed.commands, ['open', 'stop', 'close']);
});

test('internal domains such as people, sun and updates never appear unless listed', () => {
  for (const entityId of ['person.mike', 'sun.sun', 'update.core', 'zone.home']) {
    assert.equal(classify(haState(entityId, 'x', {})), null, entityId);
  }
  const listed = classify(haState('person.mike', 'home', {}), { included: new Set(['person.mike']) });
  assert.equal(listed.category, 'status');
});

test('an entity that is hidden stays hidden even when it is also listed', () => {
  const state = haState('light.kitchen', 'off', {});
  assert.equal(classify(state, { hidden: new Set(['light.kitchen']), included: new Set(['light.kitchen']) }), null);
});

test('only dimmable lights get a brightness command', () => {
  assert.deepEqual(classify(haState('light.a', 'off', { supported_color_modes: ['brightness'] })).commands, ['toggle', 'brightness']);
  assert.deepEqual(classify(haState('light.b', 'on', { supported_color_modes: ['onoff'] })).commands, ['toggle']);
  // Older lights report a brightness value without listing their colour modes.
  assert.deepEqual(classify(haState('light.c', 'on', { brightness: 100 })).commands, ['toggle', 'brightness']);
});

test('colour lights get colour and white-tone commands, and white-tone lights get white tones only', () => {
  for (const mode of ['hs', 'xy', 'rgb', 'rgbw', 'rgbww']) {
    assert.deepEqual(
      classify(haState('light.c', 'on', { supported_color_modes: [mode] })).commands,
      ['toggle', 'brightness', 'color', 'color_temp'],
      mode,
    );
  }
  assert.deepEqual(
    classify(haState('light.w', 'on', { supported_color_modes: ['color_temp'] })).commands,
    ['toggle', 'brightness', 'color_temp'],
  );
  assert.deepEqual(
    classify(haState('light.both', 'on', { supported_color_modes: ['color_temp', 'hs'] })).commands,
    ['toggle', 'brightness', 'color', 'color_temp'],
  );
});

test('describes the colour a light shows and its white range', () => {
  const on = describeEntity(haState('light.w', 'on', {
    supported_color_modes: ['color_temp'],
    color_mode: 'color_temp',
    color_temp_kelvin: 3000,
    rgb_color: [255, 180, 107],
    min_color_temp_kelvin: 2200,
    max_color_temp_kelvin: 6500,
  }));
  assert.deepEqual(on.color, { rgb: [255, 180, 107], kelvin: 3000, minKelvin: 2200, maxKelvin: 6500, clampKelvin: true });

  // Off lights report no colour, and colour lights without a white range get Home Assistant's defaults.
  const off = describeEntity(haState('light.c', 'off', { supported_color_modes: ['hs'], rgb_color: [1, 2, 3] }));
  assert.deepEqual(off.color, { rgb: null, kelvin: null, minKelvin: 2000, maxKelvin: 6535, clampKelvin: false });
});

test('maps colour commands to light.turn_on, keeping white tones in range', () => {
  const both = describeEntity(haState('light.b', 'on', {
    supported_color_modes: ['color_temp', 'rgb'],
    min_color_temp_kelvin: 2700,
    max_color_temp_kelvin: 6500,
  }));
  assert.deepEqual(serviceFor(both, 'color', [255, 0, 0]), {
    domain: 'light',
    service: 'turn_on',
    data: { entity_id: 'light.b', rgb_color: [255, 0, 0] },
  });
  assert.equal(normalizeValue(both, 'color_temp', 9000), 6500);
  assert.equal(normalizeValue(both, 'color_temp', 3333.4), 3333);
  assert.throws(() => normalizeValue(both, 'color_temp', 500), /1500 to 10000/);
  assert.throws(() => normalizeValue(both, 'color', [255, 0]), /\[red, green, blue\]/);
  assert.throws(() => normalizeValue(both, 'color', [255, 0, 1.5]), /whole number/);

  const rgbOnly = describeEntity(haState('light.c', 'on', { supported_color_modes: ['rgb'] }));
  assert.equal(normalizeValue(rgbOnly, 'color_temp', 2000), 2000, 'Home Assistant converts it, so nothing is clamped');
});

test('group commands give each light only what it supports', () => {
  const describe = (id, attributes) => describeEntity(haState(id, 'off', attributes));
  const lights = [
    describe('light.plain', { supported_color_modes: ['onoff'] }),
    describe('light.rgb', { supported_color_modes: ['rgb'] }),
    describe('light.warm', { supported_color_modes: ['color_temp'], min_color_temp_kelvin: 2700, max_color_temp_kelvin: 6500 }),
    describe('light.warm2', { supported_color_modes: ['color_temp'], min_color_temp_kelvin: 2700, max_color_temp_kelvin: 5000 }),
  ];
  assert.deepEqual(lightGroupServices(lights, 'off'), [
    { domain: 'light', service: 'turn_off', data: { entity_id: ['light.plain', 'light.rgb', 'light.warm', 'light.warm2'] } },
  ]);
  assert.deepEqual(lightGroupServices(lights, 'color', [0, 0, 255]), [
    { domain: 'light', service: 'turn_on', data: { entity_id: ['light.rgb'], rgb_color: [0, 0, 255] } },
  ]);
  assert.deepEqual(lightGroupServices(lights, 'color_temp', 2700), [
    { domain: 'light', service: 'turn_on', data: { entity_id: ['light.rgb', 'light.warm', 'light.warm2'], color_temp_kelvin: 2700 } },
  ]);
  assert.deepEqual(lightGroupServices(lights, 'color_temp', 6000).map((service) => service.data), [
    { entity_id: ['light.rgb', 'light.warm'], color_temp_kelvin: 6000 },
    { entity_id: ['light.warm2'], color_temp_kelvin: 5000 },
  ]);
  assert.deepEqual(lightGroupServices([], 'on'), [], 'no lights, no call');
  assert.deepEqual(lightGroupServices(lights.slice(0, 1), 'color', [1, 2, 3]), []);
  assert.throws(() => lightGroupServices(lights, 'on', 5), /does not take a value/);
  assert.throws(() => lightGroupServices(lights, 'blink'), /Unknown command/);
});

test('climate entities only get a temperature command when they have a target temperature', () => {
  assert.deepEqual(classify(haState('climate.a', 'heat', { temperature: 21 })).commands, ['temperature']);
  assert.deepEqual(classify(haState('climate.b', 'heat_cool', {})).commands, []);
});

test('describes brightness, cover position and climate values for the panel', () => {
  const hall = describeEntity(
    haState('light.hall', 'on', { friendly_name: 'Hall', supported_color_modes: ['brightness'], brightness: 128 }),
  );
  assert.equal(hall.name, 'Hall');
  assert.equal(hall.on, true);
  assert.equal(hall.brightness, 50);

  const blinds = describeEntity(haState('cover.blinds', 'open', { device_class: 'blind', current_position: 40 }));
  assert.equal(blinds.position, 40);
  assert.equal(blinds.on, true);

  const heating = describeEntity(
    haState('climate.living', 'heat', { temperature: 21.5, current_temperature: 20.8, target_temp_step: 0.5 }),
  );
  assert.deepEqual(heating.climate, { target: 21.5, current: 20.8, min: 7, max: 35, step: 0.5, unit: '°C' });
});

test('a light that is on without a reported level gets no made-up brightness', () => {
  assert.equal(describeEntity(haState('light.x', 'on', { supported_color_modes: ['brightness'] })).brightness, null);
});

test('an off light reports 0 brightness, even when it still carries a stale level', () => {
  assert.equal(describeEntity(haState('light.y', 'off', { supported_color_modes: ['brightness'] })).brightness, 0);
  assert.equal(describeEntity(haState('light.z', 'off', { supported_color_modes: ['brightness'], brightness: 89 })).brightness, 0);
});

test('climate limits and steps follow the temperature unit when the entity does not give them', () => {
  const info = describeEntity(haState('climate.us', 'heat', { temperature: 70, temperature_unit: '°F' })).climate;
  assert.deepEqual([info.min, info.max, info.step], [45, 95, 1]);
});

test('unavailable entities are reported as unavailable and offer no action', () => {
  const entity = describeEntity(haState('light.broken', 'unavailable', { supported_color_modes: ['onoff'] }));
  assert.equal(entity.available, false);
});

test('orders entities by room, then category, then name, and reports listed ids that are missing', () => {
  const states = [
    haState('switch.z', 'on', { friendly_name: 'Zeta switch' }),
    haState('light.b', 'on', { friendly_name: 'Bravo', supported_color_modes: ['onoff'] }),
    haState('light.a', 'on', { friendly_name: 'Alpha', supported_color_modes: ['onoff'] }),
    haState('sensor.kitchen', '20', { friendly_name: 'Kitchen temperature' }),
  ];
  const areas = new Map([
    ['light.a', { id: 'kitchen', name: 'Kitchen' }],
    ['sensor.kitchen', { id: 'kitchen', name: 'Kitchen' }],
  ]);
  const { entities, missing } = buildControls({ states, areas, included: new Set(['script.nope']) });
  assert.deepEqual(entities.map((entity) => entity.entity_id), ['light.a', 'sensor.kitchen', 'light.b', 'switch.z']);
  assert.deepEqual(missing, ['script.nope']);
});

test('maps each command to the Home Assistant service that carries it out', () => {
  const light = describeEntity(haState('light.hall', 'on', { supported_color_modes: ['brightness'] }));
  const data = { entity_id: 'light.hall' };
  assert.deepEqual(serviceFor(light, 'toggle'), { domain: 'light', service: 'toggle', data });
  assert.deepEqual(serviceFor(light, 'brightness', 40), {
    domain: 'light',
    service: 'turn_on',
    data: { entity_id: 'light.hall', brightness_pct: 40 },
  });
  assert.deepEqual(serviceFor(light, 'brightness', 0), { domain: 'light', service: 'turn_off', data });
  assert.equal(serviceFor(light, 'run'), null);

  const group = describeEntity(haState('group.all', 'off', {}), { included: new Set(['group.all']) });
  assert.equal(serviceFor(group, 'toggle').service, 'turn_on');
  const openGroup = describeEntity(haState('group.all', 'on', {}), { included: new Set(['group.all']) });
  assert.deepEqual(serviceFor(openGroup, 'toggle'), {
    domain: 'homeassistant',
    service: 'turn_off',
    data: { entity_id: 'group.all' },
  });

  const blinds = describeEntity(haState('cover.blinds', 'closed', { device_class: 'blind' }));
  assert.equal(serviceFor(blinds, 'open').service, 'open_cover');
  assert.equal(serviceFor(blinds, 'close').service, 'close_cover');
  assert.equal(serviceFor(blinds, 'stop').service, 'stop_cover');

  const heating = describeEntity(haState('climate.h', 'heat', { temperature: 20 }));
  assert.deepEqual(serviceFor(heating, 'temperature', 22), {
    domain: 'climate',
    service: 'set_temperature',
    data: { entity_id: 'climate.h', temperature: 22 },
  });

  const scene = describeEntity(haState('scene.movie', 'x', {}));
  assert.equal(serviceFor(scene, 'run').service, 'turn_on');
  const button = describeEntity(haState('button.hub', 'x', {}), { included: new Set(['button.hub']) });
  assert.deepEqual(
    { domain: serviceFor(button, 'run').domain, service: serviceFor(button, 'run').service },
    { domain: 'button', service: 'press' },
  );
});

test('checks brightness and temperature values before they reach Home Assistant', () => {
  const light = describeEntity(haState('light.h', 'on', { supported_color_modes: ['brightness'] }));
  assert.equal(normalizeValue(light, 'brightness', 42.4), 42);
  assert.throws(() => normalizeValue(light, 'brightness', 101), /0 to 100/);
  assert.throws(() => normalizeValue(light, 'brightness', '50'), /0 to 100/);

  const heating = describeEntity(haState('climate.h', 'heat', { temperature: 20, min_temp: 7, max_temp: 30 }));
  assert.equal(normalizeValue(heating, 'temperature', 21.26), 21.3);
  assert.throws(() => normalizeValue(heating, 'temperature', 31), /7 to 30/);

  assert.throws(() => normalizeValue(light, 'toggle', 1), /does not take a value/);
  assert.equal(normalizeValue(light, 'toggle', undefined), undefined);
});
