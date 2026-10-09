/*
 * Photo frame with a Home Assistant panel. Plain ES5 on purpose: iOS 12 Safari
 * cannot run newer JavaScript, and `npm test` checks this file against ES5.
 */
(function () {
  'use strict';

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  var SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  var RETRY_MS = 60 * 1000;                  // wait before asking Immich again after a failure
  var LOAD_TIMEOUT_MS = 20 * 1000;           // give up on a photo that never finishes loading
  var CONTROLS_POLL_MS = 5 * 1000;           // refresh Home Assistant while the panel is open
  var REFRESH_AFTER_COMMAND_MS = 1500;       // Home Assistant can take a moment to report a change
  var STALL_MS = 5 * 60 * 1000;              // reload if no new photo has appeared for this long
  var DAILY_RELOAD_MS = 24 * 60 * 60 * 1000; // restart once a day to keep old iPad memory fresh
  var FLASH_MS = 4 * 1000;                   // how long a failed action shows its error
  var PHOTOS_OFF_TEXT = 'Photos are off. Set IMMICH_URL and IMMICH_API_KEY on the server.';
  var HOME_OFF_TEXT = 'Home Assistant is off. Set HA_URL and HA_TOKEN on the server.';

  var CATEGORY_ORDER = ['lights', 'covers', 'switches', 'scenes', 'climate', 'status'];
  var CATEGORY_LABELS = {
    lights: 'Lights',
    covers: 'Covers',
    switches: 'Switches',
    scenes: 'Scenes',
    climate: 'Climate',
    status: 'Status'
  };

  // Defaults. The server's /api/config overrides them.
  var config = {
    intervalSeconds: 60,
    photoFit: 'auto',
    showClock: true,
    showCaptions: true,
    panelIdleSeconds: 60,
    photosEnabled: true,
    homeAssistantEnabled: true
  };

  var els = {};
  var slides = [];
  var activeSlide = 0;
  var playlist = [];
  var playlistIndex = 0;
  var hasShownPhoto = false;
  var startedAt = Date.now();
  var lastShownAt = Date.now();
  var slideTimer = null;
  var clockShown = { time: '', date: '' };

  // Home panel state
  var entities = {};    // latest entity data by entity_id
  var entityUi = {};    // per entity: busy, flash, pending brightness and temperature
  var views = [];       // every tile on screen, so an update can reach all of them
  var layoutKey = null; // changes when tiles or rooms have to be rebuilt
  var tabNames = [];
  var tabButtons = {};
  var sections = {};
  var activeTab = 'rooms';
  var panelOpen = false;
  var panelPoll = null;
  var panelIdleTimer = null;
  var refreshing = false;

  function byId(id) {
    return document.getElementById(id);
  }

  function createEl(tag, className, text) {
    var el = document.createElement(tag);
    if (className) {
      el.className = className;
    }
    if (text !== undefined) {
      el.textContent = text;
    }
    return el;
  }

  function capitalize(text) {
    text = String(text || '');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  // Home Assistant state names such as "heat_cool" read as "Heat cool".
  function humanize(text) {
    return capitalize(String(text || '').replace(/_/g, ' '));
  }

  function roundTemp(value) {
    return Math.round(value * 10) / 10;
  }

  // Shows whole degrees for whole-degree steps, and one decimal otherwise.
  function formatTemp(value, climate) {
    var decimals = climate.step % 1 === 0 ? 0 : 1;
    return value.toFixed(decimals) + ' ' + climate.unit;
  }

  function setDisabled(el, flag) {
    if (el && (el.tagName === 'BUTTON' || el.tagName === 'INPUT')) {
      el.disabled = flag;
    }
  }

  // XMLHttpRequest rather than fetch, so it works on every iOS 12 Safari.
  function request(method, url, body, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.timeout = 15000;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) {
        return;
      }
      var data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch (e) {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        callback(null, data);
      } else {
        callback((data && data.error) || 'Request failed (' + (xhr.status || 'no response') + ')', data);
      }
    };
    if (body) {
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify(body));
    } else {
      xhr.send(null);
    }
  }

  function loadConfig(done) {
    request('GET', 'api/config', null, function (err, body) {
      if (body) {
        for (var key in body) {
          if (body.hasOwnProperty(key)) {
            config[key] = body[key];
          }
        }
      }
      done();
    });
  }

  function pad(number) {
    return number < 10 ? '0' + number : String(number);
  }

  function renderClock() {
    var now = new Date();
    var time = pad(now.getHours()) + ':' + pad(now.getMinutes());
    var date = DAYS[now.getDay()] + ', ' + now.getDate() + ' ' + MONTHS[now.getMonth()];
    if (time !== clockShown.time) {
      clockShown.time = time;
      els.clockTime.textContent = time;
    }
    if (date !== clockShown.date) {
      clockShown.date = date;
      els.clockDate.textContent = date;
    }
  }

  // Immich stores the local wall-clock time, so the date parts are read as written.
  function formatTakenAt(value) {
    var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || '');
    if (!match) {
      return '';
    }
    var monthIndex = parseInt(match[2], 10) - 1;
    if (monthIndex < 0 || monthIndex > 11) {
      return '';
    }
    return parseInt(match[3], 10) + ' ' + SHORT_MONTHS[monthIndex] + ' ' + match[1];
  }

  function showMessage(text) {
    els.message.textContent = text || '';
    els.message.className = text ? 'message' : 'message hidden';
  }

  // "cover" fills the screen. A portrait photo on a landscape screen would lose
  // too much to cropping, so it uses "contain" and is shown whole.
  function fitFor(img) {
    if (config.photoFit === 'cover' || config.photoFit === 'contain') {
      return config.photoFit;
    }
    var imageRatio = img.naturalWidth / img.naturalHeight;
    var screenRatio = window.innerWidth / window.innerHeight;
    return Math.abs(imageRatio - screenRatio) / screenRatio > 0.35 ? 'contain' : 'cover';
  }

  function refitVisibleSlide() {
    var visible = slides[activeSlide];
    if (visible && visible.naturalWidth) {
      visible.style.objectFit = fitFor(visible);
    }
  }

  function fetchPlaylist(callback) {
    request('GET', 'api/photos', null, function (err, body) {
      var photos = body && body.photos ? body.photos : [];
      if (photos.length === 0) {
        callback(err || 'No photos found in Immich yet.');
        return;
      }
      playlist = photos;
      playlistIndex = 0;
      callback(null);
    });
  }

  function scheduleNextSlide(delayMs) {
    clearTimeout(slideTimer);
    slideTimer = setTimeout(showNextSlide, delayMs);
  }

  function showNextSlide() {
    clearTimeout(slideTimer);
    if (!config.photosEnabled) {
      showMessage(PHOTOS_OFF_TEXT);
      return;
    }
    if (playlistIndex < playlist.length) {
      loadPhoto(playlist[playlistIndex++]);
      return;
    }
    fetchPlaylist(function (err) {
      if (err) {
        if (!hasShownPhoto) {
          showMessage(err);
        }
        scheduleNextSlide(RETRY_MS);
        return;
      }
      loadPhoto(playlist[playlistIndex++]);
    });
  }

  // Two <img> elements take turns: the next photo loads behind the current one
  // and then fades in.
  function loadPhoto(photo) {
    var incoming = slides[1 - activeSlide];
    var url = 'api/photos/' + encodeURIComponent(photo.id) + '/image';
    var finished = false;
    var guard = null;

    function finish(ok) {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(guard);
      incoming.onload = null;
      incoming.onerror = null;
      if (ok) {
        showPhoto(incoming, photo);
      } else {
        scheduleNextSlide(2000);
      }
    }

    incoming.onload = function () {
      finish(true);
    };
    incoming.onerror = function () {
      finish(false);
    };
    guard = setTimeout(function () {
      finish(false);
    }, LOAD_TIMEOUT_MS);

    // Showing the same photo again fires no load event, so reuse the loaded one.
    if (incoming.getAttribute('src') === url && incoming.complete && incoming.naturalWidth > 0) {
      finish(true);
    } else {
      incoming.src = url;
    }
  }

  function showPhoto(img, photo) {
    var outgoing = slides[activeSlide];
    img.style.objectFit = fitFor(img);
    img.className = 'slide visible';
    outgoing.className = 'slide';
    activeSlide = 1 - activeSlide;
    hasShownPhoto = true;
    lastShownAt = Date.now();
    showMessage('');

    var caption = config.showCaptions ? formatTakenAt(photo.takenAt) : '';
    els.caption.textContent = caption;
    els.caption.className = caption ? 'caption' : 'caption hidden';

    scheduleNextSlide(config.intervalSeconds * 1000);
  }

  // Restarts the page when the slideshow has silently stalled, and once a day.
  // It never interrupts someone using the home panel.
  function watchdog() {
    if (panelOpen) {
      return;
    }
    var now = Date.now();
    var stalled = config.photosEnabled && now - lastShownAt > STALL_MS;
    if (stalled || now - startedAt > DAILY_RELOAD_MS) {
      window.location.reload();
    }
  }

  // ---- Home panel -------------------------------------------------------

  function setPanelNote(text) {
    els.panelNote.textContent = text || '';
    els.panelNote.className = text ? 'panel-note' : 'panel-note hidden';
  }

  function openPanel() {
    panelOpen = true;
    els.panel.className = 'panel';
    if (views.length === 0) {
      setPanelNote('Loading controls...');
    }
    refreshControls();
    panelPoll = setInterval(refreshControls, CONTROLS_POLL_MS);
    touchPanel();
  }

  function closePanel() {
    panelOpen = false;
    els.panel.className = 'panel hidden';
    clearInterval(panelPoll);
    panelPoll = null;
    clearTimeout(panelIdleTimer);
    panelIdleTimer = null;
  }

  // Any touch in the panel restarts the countdown back to the photos.
  function touchPanel() {
    clearTimeout(panelIdleTimer);
    panelIdleTimer = setTimeout(closePanel, config.panelIdleSeconds * 1000);
  }

  function refreshControls() {
    if (refreshing) {
      return;
    }
    refreshing = true;
    request('GET', 'api/ha/controls', null, function (err, body) {
      refreshing = false;
      if (err) {
        setPanelNote(err);
        return;
      }
      if (!body || !body.configured) {
        setPanelNote(HOME_OFF_TEXT);
        return;
      }
      applyControls(body);
    });
  }

  function applyControls(data) {
    var list = data.entities || [];
    entities = {};
    for (var i = 0; i < list.length; i++) {
      entities[list[i].entity_id] = list[i];
    }

    var key = layoutSignature(list, data.areasAvailable);
    if (key !== layoutKey) {
      layoutKey = key;
      buildLayout(list);
    } else {
      for (var v = 0; v < views.length; v++) {
        renderView(views[v]);
      }
    }

    var notes = [];
    if (list.length === 0) {
      notes.push('No controls found in Home Assistant.');
    }
    if (data.areasAvailable === false) {
      notes.push('Room names are unavailable, so entities are listed under No room.');
    }
    if (data.missing && data.missing.length) {
      notes.push('Not found in Home Assistant: ' + data.missing.join(', ') + '.');
    }
    setPanelNote(notes.join(' '));
  }

  // Tiles only need rebuilding when the set of entities, their rooms or their
  // controls change. Changing states are updated in place, so taps and slider
  // drags are not interrupted by the regular refresh.
  function layoutSignature(list, areasAvailable) {
    var rows = [areasAvailable === false ? 0 : 1];
    for (var i = 0; i < list.length; i++) {
      var entity = list[i];
      rows.push([entity.entity_id, entity.category, entity.area_id, entity.area, entity.commands.join(',')]);
    }
    return JSON.stringify(rows);
  }

  function buildLayout(list) {
    els.tabs.innerHTML = '';
    els.content.innerHTML = '';
    views = [];
    tabNames = [];
    tabButtons = {};
    sections = {};

    var rooms = [];
    var roomInfo = {};
    var byCategory = {};
    for (var i = 0; i < list.length; i++) {
      var entity = list[i];
      var key = entity.area_id || '';
      if (!roomInfo[key]) {
        roomInfo[key] = { title: entity.area || 'No room', ids: [], hasLights: false };
        rooms.push(key);
      }
      roomInfo[key].ids.push(entity.entity_id);
      if (entity.category === 'lights') {
        roomInfo[key].hasLights = true;
      }
      if (!byCategory[entity.category]) {
        byCategory[entity.category] = [];
      }
      byCategory[entity.category].push(entity.entity_id);
    }

    if (list.length > 0) {
      addTab('rooms', 'Rooms', buildRoomsSection(rooms, roomInfo));
    }
    for (var c = 0; c < CATEGORY_ORDER.length; c++) {
      var name = CATEGORY_ORDER[c];
      if (byCategory[name]) {
        addTab(name, CATEGORY_LABELS[name], buildCategorySection(byCategory[name]));
      }
    }
    showTab(tabNames.indexOf(activeTab) !== -1 ? activeTab : tabNames[0]);
  }

  function addTab(name, label, section) {
    var button = createEl('button', 'tab', label);
    button.type = 'button';
    button.onclick = function () {
      showTab(name);
      touchPanel();
    };
    els.tabs.appendChild(button);
    els.content.appendChild(section);
    tabNames.push(name);
    tabButtons[name] = button;
    sections[name] = section;
  }

  function showTab(name) {
    if (!name) {
      return;
    }
    activeTab = name;
    for (var i = 0; i < tabNames.length; i++) {
      var current = tabNames[i];
      tabButtons[current].className = current === name ? 'tab is-active' : 'tab';
      sections[current].className = current === name ? 'section' : 'section hidden';
    }
    els.content.scrollTop = 0;
  }

  function buildRoomsSection(rooms, roomInfo) {
    var section = createEl('div', 'section hidden');
    for (var r = 0; r < rooms.length; r++) {
      var key = rooms[r];
      var info = roomInfo[key];
      var room = createEl('div', 'room');
      var head = createEl('div', 'room-head');
      head.appendChild(createEl('div', 'room-title', info.title));
      if (key !== '' && info.hasLights) {
        head.appendChild(makeRoomLightsOffButton(key));
      }
      room.appendChild(head);

      var tiles = createEl('div', 'tiles');
      for (var i = 0; i < info.ids.length; i++) {
        tiles.appendChild(buildView(info.ids[i]).el);
      }
      room.appendChild(tiles);
      section.appendChild(room);
    }
    return section;
  }

  function buildCategorySection(ids) {
    var section = createEl('div', 'section hidden');
    var tiles = createEl('div', 'tiles');
    for (var i = 0; i < ids.length; i++) {
      tiles.appendChild(buildView(ids[i]).el);
    }
    section.appendChild(tiles);
    return section;
  }

  function makeRoomLightsOffButton(areaId) {
    var button = createEl('button', 'room-off', 'Lights off');
    button.type = 'button';
    button.onclick = function () {
      lightsOffInRoom(areaId, button);
    };
    return button;
  }

  function lightsOffInRoom(areaId, button) {
    touchPanel();
    button.disabled = true;
    request('POST', 'api/ha/rooms/' + encodeURIComponent(areaId) + '/lights-off', {}, function (err) {
      button.disabled = false;
      if (err) {
        setPanelNote(err);
      }
      setTimeout(function () {
        if (panelOpen) {
          refreshControls();
        }
      }, REFRESH_AFTER_COMMAND_MS);
    });
  }

  // The kind of tile follows from the commands the server allows for the entity.
  function kindOf(entity) {
    var commands = entity.commands;
    if (commands.indexOf('brightness') !== -1) {
      return 'light';
    }
    if (commands.indexOf('toggle') !== -1) {
      return 'toggle';
    }
    if (commands.indexOf('run') !== -1) {
      return 'run';
    }
    if (commands.indexOf('open') !== -1) {
      return 'cover';
    }
    if (commands.indexOf('temperature') !== -1) {
      return 'climate';
    }
    return 'info';
  }

  function uiFor(entityId) {
    if (!entityUi[entityId]) {
      entityUi[entityId] = { busy: false, flash: '', pendingBrightness: undefined, pendingTarget: undefined };
    }
    return entityUi[entityId];
  }

  function makeCommand(entityId, command) {
    return function () {
      commandEntity(entityId, command);
    };
  }

  function makeActionButton(entityId, command, label, view) {
    var button = createEl('button', 'tile-action', label);
    button.type = 'button';
    button.onclick = makeCommand(entityId, command);
    view.controls.push(button);
    return button;
  }

  function makeStepButton(entityId, direction, label, view) {
    var button = createEl('button', 'tile-action', label);
    button.type = 'button';
    button.onclick = function () {
      stepTemperature(entityId, direction);
    };
    view.controls.push(button);
    return button;
  }

  function buildView(entityId) {
    var kind = kindOf(entities[entityId]);
    var view = {
      entityId: entityId,
      kind: kind,
      el: null,
      nameEl: createEl('div', 'tile-name'),
      statusEl: createEl('div', 'tile-status'),
      sliderEl: null,
      sliding: false,
      controls: []
    };

    if (kind === 'toggle' || kind === 'run') {
      view.el = createEl('button', 'tile');
      view.el.type = 'button';
      view.el.appendChild(view.nameEl);
      view.el.appendChild(view.statusEl);
      view.el.onclick = makeCommand(entityId, kind === 'run' ? 'run' : 'toggle');
      view.controls.push(view.el);
    } else if (kind === 'light') {
      view.el = createEl('div', 'tile');
      var main = createEl('button', 'tile-main');
      main.type = 'button';
      main.appendChild(view.nameEl);
      main.appendChild(view.statusEl);
      main.onclick = makeCommand(entityId, 'toggle');
      view.el.appendChild(main);

      var slider = createEl('input', 'slider');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.step = '1';
      slider.oninput = function () {
        view.sliding = true;
        var ui = uiFor(entityId);
        ui.pendingBrightness = parseInt(slider.value, 10);
        view.statusEl.textContent = statusText(entities[entityId], ui);
      };
      slider.onchange = function () {
        view.sliding = false;
        commandEntity(entityId, 'brightness', parseInt(slider.value, 10));
      };
      view.el.appendChild(slider);
      view.sliderEl = slider;
      view.controls.push(main, slider);
    } else {
      view.el = createEl('div', 'tile');
      view.el.appendChild(view.nameEl);
      view.el.appendChild(view.statusEl);
      if (kind === 'cover') {
        var covers = createEl('div', 'tile-actions');
        covers.appendChild(makeActionButton(entityId, 'open', 'Open', view));
        covers.appendChild(makeActionButton(entityId, 'stop', 'Stop', view));
        covers.appendChild(makeActionButton(entityId, 'close', 'Close', view));
        view.el.appendChild(covers);
      } else if (kind === 'climate') {
        var climate = createEl('div', 'tile-actions');
        climate.appendChild(makeStepButton(entityId, -1, '−', view));
        climate.appendChild(makeStepButton(entityId, 1, '+', view));
        view.el.appendChild(climate);
      }
    }

    views.push(view);
    renderView(view);
    return view;
  }

  // The level the slider and status show: a pending change, else what Home Assistant
  // reports. That is null when a light is on but reports no level.
  function brightnessShown(entity, ui) {
    if (ui.pendingBrightness !== undefined) {
      return ui.pendingBrightness;
    }
    return entity.brightness;
  }

  function statusText(entity, ui) {
    var kind = kindOf(entity);
    if (!entity.available) {
      return 'Unavailable';
    }
    if (kind === 'light') {
      if (ui.pendingBrightness !== undefined) {
        return ui.pendingBrightness > 0 ? 'On · ' + ui.pendingBrightness + '%' : 'Off';
      }
      if (!entity.on) {
        return 'Off';
      }
      return entity.brightness === null ? 'On' : 'On · ' + entity.brightness + '%';
    }
    if (kind === 'toggle') {
      return humanize(entity.state);
    }
    if (kind === 'run') {
      return 'Tap to run';
    }
    if (kind === 'cover') {
      return humanize(entity.state) + (entity.position !== null ? ' · ' + entity.position + '%' : '');
    }
    if (kind === 'climate') {
      var target = ui.pendingTarget !== undefined ? ui.pendingTarget : entity.climate.target;
      var text = 'Target ' + formatTemp(target, entity.climate);
      if (entity.climate.current !== null) {
        text += ' · now ' + formatTemp(entity.climate.current, entity.climate);
      }
      return text;
    }
    return humanize(entity.state) + (entity.unit ? ' ' + entity.unit : '');
  }

  function renderView(view) {
    var entity = entities[view.entityId];
    if (!entity) {
      return;
    }
    var ui = uiFor(view.entityId);

    var classes = ['tile', 'tile-' + view.kind];
    if (view.kind === 'toggle' || view.kind === 'light') {
      classes.push(entity.on ? 'is-on' : 'is-off');
    } else if (view.kind === 'info') {
      classes.push('is-info');
    }
    if (!entity.available) {
      classes.push('is-unavailable');
    }
    if (ui.flash) {
      classes.push('is-failed');
    }
    if (ui.busy) {
      classes.push('is-busy');
    }
    view.el.className = classes.join(' ');

    view.nameEl.textContent = entity.name;
    view.statusEl.textContent = ui.flash || statusText(entity, ui);

    var disabled = !entity.available || ui.busy;
    for (var i = 0; i < view.controls.length; i++) {
      setDisabled(view.controls[i], disabled);
    }

    // Leave the slider where it is when Home Assistant reports no level.
    var level = brightnessShown(entity, ui);
    if (view.sliderEl && !view.sliding && level !== null && level !== undefined) {
      view.sliderEl.value = String(level);
    }
  }

  function renderEntity(entityId) {
    for (var i = 0; i < views.length; i++) {
      if (views[i].entityId === entityId) {
        renderView(views[i]);
      }
    }
  }

  function commandEntity(entityId, command, value) {
    var ui = uiFor(entityId);
    if (ui.busy) {
      return;
    }
    touchPanel();
    ui.busy = true;
    ui.flash = '';
    if (command === 'brightness') {
      ui.pendingBrightness = value;
    }
    if (command === 'temperature') {
      ui.pendingTarget = value;
    }
    renderEntity(entityId);

    var body = { command: command };
    if (value !== undefined) {
      body.value = value;
    }
    request('POST', 'api/ha/entities/' + encodeURIComponent(entityId) + '/command', body, function (err, response) {
      ui.busy = false;
      ui.pendingBrightness = undefined;
      ui.pendingTarget = undefined;
      if (err) {
        ui.flash = err;
        setTimeout(function () {
          ui.flash = '';
          renderEntity(entityId);
        }, FLASH_MS);
      } else if (response && response.entity) {
        entities[entityId] = response.entity;
      }
      renderEntity(entityId);
      setTimeout(function () {
        if (panelOpen) {
          refreshControls();
        }
      }, REFRESH_AFTER_COMMAND_MS);
    });
  }

  function stepTemperature(entityId, direction) {
    var entity = entities[entityId];
    if (!entity || !entity.climate) {
      return;
    }
    var ui = uiFor(entityId);
    var current = ui.pendingTarget !== undefined ? ui.pendingTarget : entity.climate.target;
    var next = roundTemp(current + direction * entity.climate.step);
    if (next < entity.climate.min || next > entity.climate.max) {
      return;
    }
    commandEntity(entityId, 'temperature', next);
  }

  function findElements() {
    els.frame = byId('frame');
    els.clock = byId('clock');
    els.clockTime = byId('clock-time');
    els.clockDate = byId('clock-date');
    els.caption = byId('caption');
    els.message = byId('message');
    els.panel = byId('panel');
    els.panelClose = byId('panel-close');
    els.panelNote = byId('panel-note');
    els.tabs = byId('tabs');
    els.content = byId('content');
    slides = [byId('slide-a'), byId('slide-b')];
  }

  function init() {
    findElements();
    // iOS only sends click events for elements with a click handler, so the
    // handler is set as a property rather than with addEventListener.
    els.frame.onclick = function () {
      if (!panelOpen) {
        openPanel();
      }
    };
    els.panelClose.onclick = closePanel;
    els.panel.ontouchstart = function () {
      if (panelOpen) {
        touchPanel();
      }
    };
    window.onresize = refitVisibleSlide;
    showMessage('Loading photos...');

    loadConfig(function () {
      if (!config.showClock) {
        els.clock.className = 'clock hidden';
      }
      renderClock();
      setInterval(renderClock, 1000);
      setInterval(watchdog, 30 * 1000);
      showNextSlide();
    });
  }

  init();
}());
