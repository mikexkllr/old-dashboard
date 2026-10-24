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
  var FADE_MS = 1500;                        // the .slide.is-front transition in style.css
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

  // Line icons on a 24 x 24 grid, one SVG path each. Solid ones are filled.
  var ICONS = {
    bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z',
    power: 'M12 3v8M7.1 6.3a7.5 7.5 0 1 0 9.8 0',
    blinds: 'M3 4h18M5 4v12M19 4v12M5 8h14M5 12h14M5 16h14M12 16v4',
    thermometer: 'M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z',
    sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z',
    lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
    tv: 'M3 5h18v12H3zM8 21h8M12 17v4',
    door: 'M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M4 21h16M14.5 12h.01',
    pulse: 'M3 12h4l3-7 4 14 3-7h4',
    photos: 'M3 5h18v14H3zM3 16l5-5 5 5 3-3 5 5M15.5 9.5h.01',
    up: 'M6 15l6-6 6 6',
    down: 'M6 9l6 6 6-6',
    minus: 'M6 12h12',
    plus: 'M12 6v12M6 12h12',
    stop: 'M7 7h10v10H7z',
    play: 'M7 4.5v15L19.5 12z'
  };
  var SOLID_ICONS = { stop: true, play: true };

  var DOMAIN_ICONS = {
    'light': 'bulb',
    'switch': 'power',
    'fan': 'power',
    'input_boolean': 'power',
    'automation': 'power',
    'group': 'power',
    'cover': 'blinds',
    'climate': 'thermometer',
    'scene': 'sparkle',
    'script': 'sparkle',
    'button': 'sparkle',
    'input_button': 'sparkle',
    'lock': 'lock',
    'media_player': 'tv',
    'binary_sensor': 'door'
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
  var slides = [];      // two layers that take turns: { el, fill, photo }
  var activeSlide = 0;
  var fadeTimer = null;
  var playlist = [];
  var playlistIndex = 0;
  var hasShownPhoto = false;
  var startedAt = Date.now();
  var lastShownAt = Date.now();
  var slideTimer = null;
  var clockShown = { time: '', date: '' };
  var serverStartedAt = null;

  // Home panel state
  var entities = {};    // latest entity data by entity_id
  var entityUi = {};    // per entity: busy, flash, pending brightness and temperature
  var views = [];       // every tile on screen, so an update can reach all of them
  var roomViews = [];   // every room heading, for its summary and All off button
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

  // These write only on a change, so the regular refresh does not make the
  // old iPad lay out every tile again.
  function setText(el, text) {
    if (el.textContent !== text) {
      el.textContent = text;
    }
  }

  function setClass(el, className) {
    if (el.className !== className) {
      el.className = className;
    }
  }

  function makeIcon(name, className) {
    var span = createEl('span', (className || 'icon') + (SOLID_ICONS[name] ? ' is-solid' : ''));
    // The paths are the constants above, so no outside text reaches innerHTML.
    span.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + ICONS[name] + '"/></svg>';
    return span;
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
    if (el && (el.tagName === 'BUTTON' || el.tagName === 'INPUT') && el.disabled !== flag) {
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
      if (body && body.startedAt) {
        serverStartedAt = body.startedAt;
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
      els.panelTime.textContent = time;
    }
    if (date !== clockShown.date) {
      clockShown.date = date;
      els.clockDate.textContent = date;
      els.panelDate.textContent = date;
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
    els.messageText.textContent = text || '';
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

  // A photo shown whole gets a blurred copy of itself behind it instead of black
  // bars. The copy reuses the loaded image, so it costs no second download.
  function applyFit(slide) {
    var fit = fitFor(slide.photo);
    slide.photo.style.objectFit = fit;
    if (fit === 'contain') {
      var url = slide.photo.getAttribute('src');
      if (slide.fill.getAttribute('src') !== url) {
        slide.fill.src = url;
      }
      setClass(slide.fill, 'slide-fill');
    } else {
      setClass(slide.fill, 'slide-fill hidden');
    }
  }

  function refitVisibleSlide() {
    var visible = slides[activeSlide];
    if (visible && visible.photo.naturalWidth) {
      applyFit(visible);
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

  // The next photo loads into the slide that is not showing, then fades in.
  function loadPhoto(photo) {
    var incoming = slides[1 - activeSlide];
    var img = incoming.photo;
    var url = 'api/photos/' + encodeURIComponent(photo.id) + '/image';
    var finished = false;
    var guard = null;

    function finish(ok) {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(guard);
      img.onload = null;
      img.onerror = null;
      if (ok) {
        showPhoto(incoming, photo);
      } else {
        scheduleNextSlide(2000);
      }
    }

    img.onload = function () {
      finish(true);
    };
    img.onerror = function () {
      finish(false);
    };
    guard = setTimeout(function () {
      finish(false);
    }, LOAD_TIMEOUT_MS);

    // Showing the same photo again fires no load event, so reuse the loaded one.
    if (img.getAttribute('src') === url && img.complete && img.naturalWidth > 0) {
      finish(true);
    } else {
      img.src = url;
    }
  }

  function showPhoto(slide, photo) {
    var outgoing = slides[activeSlide];
    applyFit(slide);

    // The old photo stays fully visible underneath while the new one fades in
    // on top, so the picture never dips towards black halfway.
    outgoing.el.className = 'slide is-back';
    slide.el.className = 'slide';
    // Reading a layout value applies the transparent state first, so the
    // fade always starts from nothing.
    void slide.el.offsetWidth;
    slide.el.className = 'slide is-front';
    activeSlide = 1 - activeSlide;

    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(function () {
      if (slides[activeSlide] !== outgoing) {
        outgoing.el.className = 'slide';
      }
    }, FADE_MS + 200);

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

  // A redeploy starts a new server with a new start time. Reloading then picks up
  // the new code. It waits until nobody is using the home panel.
  function checkForNewServer() {
    if (panelOpen) {
      return;
    }
    request('GET', 'api/config', null, function (err, body) {
      if (err || !body || !body.startedAt) {
        return;
      }
      if (serverStartedAt === null) {
        serverStartedAt = body.startedAt;
      } else if (body.startedAt !== serverStartedAt) {
        window.location.reload();
      }
    });
  }

  // ---- Home panel -------------------------------------------------------

  function setPanelNote(text) {
    els.panelNote.textContent = text || '';
    els.panelNote.className = text ? 'panel-note' : 'panel-note hidden';
  }

  function openPanel() {
    panelOpen = true;
    els.panel.className = 'panel';
    els.frame.className = 'is-covered';
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
    els.frame.className = '';
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
      renderRooms();
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
    roomViews = [];
    tabNames = [];
    tabButtons = {};
    sections = {};

    // The server sorts by room, so rooms come out in order with No room last.
    var rooms = [];
    var roomInfo = {};
    var categories = {};
    for (var i = 0; i < list.length; i++) {
      var entity = list[i];
      var key = entity.area_id || '';
      if (!roomInfo[key]) {
        roomInfo[key] = { title: entity.area || 'No room', entities: [] };
        rooms.push(key);
      }
      roomInfo[key].entities.push(entity);
      categories[entity.category] = true;
    }

    if (list.length > 0) {
      addTab('rooms', 'Rooms', buildSection(rooms, roomInfo, null));
    }
    for (var c = 0; c < CATEGORY_ORDER.length; c++) {
      var name = CATEGORY_ORDER[c];
      if (categories[name]) {
        addTab(name, CATEGORY_LABELS[name], buildSection(rooms, roomInfo, name));
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

  // Every tab lists its entities by room, so a light called "Ceiling" still
  // says which ceiling. A category tab leaves out the other categories.
  function buildSection(rooms, roomInfo, category) {
    var section = createEl('div', 'section hidden');
    for (var r = 0; r < rooms.length; r++) {
      var info = roomInfo[rooms[r]];
      var ids = [];
      var lightIds = [];
      for (var i = 0; i < info.entities.length; i++) {
        var entity = info.entities[i];
        if (category === null || entity.category === category) {
          ids.push(entity.entity_id);
          if (entity.domain === 'light') {
            lightIds.push(entity.entity_id);
          }
        }
      }
      if (ids.length > 0) {
        section.appendChild(buildRoom(rooms[r], info.title, ids, lightIds));
      }
    }
    return section;
  }

  function buildRoom(areaId, title, ids, lightIds) {
    var room = createEl('div', 'room');
    var head = createEl('div', 'room-head');
    var titles = createEl('div', 'room-titles');
    titles.appendChild(createEl('div', 'room-title', title));
    var roomView = { lightIds: lightIds, summaryEl: createEl('div', 'room-summary'), offButton: null };
    titles.appendChild(roomView.summaryEl);
    head.appendChild(titles);
    if (areaId !== '' && lightIds.length > 0) {
      roomView.offButton = makeRoomLightsOffButton(areaId);
      head.appendChild(roomView.offButton);
    }
    room.appendChild(head);
    roomViews.push(roomView);

    var tiles = createEl('div', 'tiles');
    for (var i = 0; i < ids.length; i++) {
      tiles.appendChild(buildView(ids[i]).el);
    }
    room.appendChild(tiles);
    renderRoom(roomView);
    return room;
  }

  // "2 lights on" under the room name. All off only shows while a light is on.
  function renderRoom(roomView) {
    if (roomView.lightIds.length === 0) {
      return;
    }
    var on = 0;
    for (var i = 0; i < roomView.lightIds.length; i++) {
      var entity = entities[roomView.lightIds[i]];
      if (entity && entity.on) {
        on++;
      }
    }
    setText(roomView.summaryEl, on === 0 ? 'All lights off' : on === 1 ? '1 light on' : on + ' lights on');
    if (roomView.offButton) {
      setClass(roomView.offButton, on > 0 ? 'room-off' : 'room-off hidden');
    }
  }

  function renderRooms() {
    for (var i = 0; i < roomViews.length; i++) {
      renderRoom(roomViews[i]);
    }
  }

  function makeRoomLightsOffButton(areaId) {
    var button = createEl('button', 'room-off');
    button.type = 'button';
    button.appendChild(makeIcon('power'));
    button.appendChild(createEl('span', null, 'All off'));
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

  function iconFor(entity) {
    if (DOMAIN_ICONS.hasOwnProperty(entity.domain)) {
      return DOMAIN_ICONS[entity.domain];
    }
    return 'pulse';
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

  function makeIconButton(icon, label, onclick, view) {
    var button = createEl('button', 'tile-action');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.appendChild(makeIcon(icon));
    button.onclick = onclick;
    view.controls.push(button);
    return button;
  }

  function makeActionButton(entityId, command, icon, label, view) {
    return makeIconButton(icon, label, makeCommand(entityId, command), view);
  }

  function makeStepButton(entityId, direction, view) {
    return makeIconButton(direction < 0 ? 'minus' : 'plus', direction < 0 ? 'Lower' : 'Raise', function () {
      stepTemperature(entityId, direction);
    }, view);
  }

  function makeSwitch() {
    var track = createEl('span', 'switch');
    track.appendChild(createEl('span', 'switch-knob'));
    return track;
  }

  function makeSlider(entityId, view) {
    var box = createEl('div', 'slider');
    var track = createEl('div', 'slider-track');
    view.fillEl = createEl('div', 'slider-fill');
    track.appendChild(view.fillEl);
    box.appendChild(track);

    var slider = createEl('input', 'slider-input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.setAttribute('aria-label', 'Brightness');
    slider.oninput = function () {
      view.sliding = true;
      uiFor(entityId).pendingBrightness = parseInt(slider.value, 10);
      renderView(view);
    };
    slider.onchange = function () {
      view.sliding = false;
      commandEntity(entityId, 'brightness', parseInt(slider.value, 10));
    };
    box.appendChild(slider);
    view.sliderEl = slider;
    view.controls.push(slider);
    return box;
  }

  // Every tile has a head (icon, name, status) at the top and a foot at the
  // bottom: a switch, slider, buttons or value, depending on the kind.
  function buildView(entityId) {
    var entity = entities[entityId];
    var kind = kindOf(entity);
    var view = {
      entityId: entityId,
      kind: kind,
      el: null,
      nameEl: createEl('div', 'tile-name'),
      statusEl: createEl('div', kind === 'info' ? 'tile-value' : 'tile-status'),
      valueEl: null,
      sliderEl: null,
      fillEl: null,
      sliding: false,
      controls: []
    };

    var head = createEl('div', 'tile-head');
    head.appendChild(makeIcon(iconFor(entity), 'icon tile-icon'));
    var text = createEl('div', 'tile-text');
    text.appendChild(view.nameEl);
    if (kind !== 'info') {
      text.appendChild(view.statusEl);
    }
    head.appendChild(text);
    var foot = createEl('div', 'tile-foot');

    if (kind === 'toggle' || kind === 'run') {
      // The whole tile is the button.
      view.el = createEl('button', 'tile');
      view.el.type = 'button';
      view.el.onclick = makeCommand(entityId, kind === 'run' ? 'run' : 'toggle');
      view.controls.push(view.el);
      foot.appendChild(kind === 'run' ? makeIcon('play', 'icon run-mark') : makeSwitch());
      view.el.appendChild(head);
      view.el.appendChild(foot);
    } else if (kind === 'light') {
      // A button under the whole tile toggles; the slider sits on top of it.
      view.el = createEl('div', 'tile');
      var main = createEl('button', 'tile-main');
      main.type = 'button';
      main.onclick = makeCommand(entityId, 'toggle');
      main.appendChild(head);
      view.controls.push(main);
      foot.appendChild(makeSlider(entityId, view));
      view.el.appendChild(main);
      view.el.appendChild(foot);
    } else {
      view.el = createEl('div', 'tile');
      view.el.appendChild(head);
      if (kind === 'cover') {
        foot.className = 'tile-foot tile-buttons';
        foot.appendChild(makeActionButton(entityId, 'open', 'up', 'Open', view));
        foot.appendChild(makeActionButton(entityId, 'stop', 'stop', 'Stop', view));
        foot.appendChild(makeActionButton(entityId, 'close', 'down', 'Close', view));
      } else if (kind === 'climate') {
        foot.className = 'tile-foot tile-stepper';
        foot.appendChild(makeStepButton(entityId, -1, view));
        view.valueEl = createEl('div', 'stepper-value');
        foot.appendChild(view.valueEl);
        foot.appendChild(makeStepButton(entityId, 1, view));
      } else {
        foot.appendChild(view.statusEl);
      }
      view.el.appendChild(foot);
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

  // A light being dragged up from 0 already looks on.
  function isLit(entity, ui) {
    if (ui.pendingBrightness !== undefined) {
      return ui.pendingBrightness > 0;
    }
    return entity.on;
  }

  function targetShown(entity, ui) {
    return ui.pendingTarget !== undefined ? ui.pendingTarget : entity.climate.target;
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
      var text = humanize(entity.state);
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

    var classes = ['tile', 'tile-' + view.kind, 'cat-' + entity.category];
    if (view.kind === 'light') {
      classes.push(isLit(entity, ui) ? 'is-on' : 'is-off');
    } else if (view.kind === 'toggle') {
      classes.push(entity.on ? 'is-on' : 'is-off');
    } else if ((view.kind === 'cover' && entity.on) || (view.kind === 'climate' && entity.state !== 'off')) {
      classes.push('is-active');
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
    setClass(view.el, classes.join(' '));

    setText(view.nameEl, entity.name);
    setText(view.statusEl, ui.flash || statusText(entity, ui));
    if (view.valueEl) {
      setText(view.valueEl, formatTemp(targetShown(entity, ui), entity.climate));
    }

    var disabled = !entity.available || ui.busy;
    for (var i = 0; i < view.controls.length; i++) {
      setDisabled(view.controls[i], disabled);
    }

    // Leave the slider where it is when Home Assistant reports no level.
    var level = brightnessShown(entity, ui);
    if (view.sliderEl && level !== null && level !== undefined) {
      if (!view.sliding) {
        view.sliderEl.value = String(level);
      }
      view.fillEl.style.width = level + '%';
    }
  }

  function renderEntity(entityId) {
    for (var i = 0; i < views.length; i++) {
      if (views[i].entityId === entityId) {
        renderView(views[i]);
      }
    }
    renderRooms();
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
    var next = roundTemp(targetShown(entity, ui) + direction * entity.climate.step);
    if (next < entity.climate.min || next > entity.climate.max) {
      return;
    }
    commandEntity(entityId, 'temperature', next);
  }

  function slideParts(el) {
    var images = el.getElementsByTagName('img');
    return { el: el, fill: images[0], photo: images[1] };
  }

  function findElements() {
    els.frame = byId('frame');
    els.clock = byId('clock');
    els.clockTime = byId('clock-time');
    els.clockDate = byId('clock-date');
    els.caption = byId('caption');
    els.message = byId('message');
    els.messageText = byId('message-text');
    els.panel = byId('panel');
    els.panelTime = byId('panel-time');
    els.panelDate = byId('panel-date');
    els.panelClose = byId('panel-close');
    els.panelNote = byId('panel-note');
    els.tabs = byId('tabs');
    els.content = byId('content');
    slides = [slideParts(byId('slide-a')), slideParts(byId('slide-b'))];
  }

  function init() {
    findElements();
    els.panelClose.insertBefore(makeIcon('photos'), els.panelClose.firstChild);
    // iOS only sends click events for elements with a click handler, so the
    // handler is set as a property rather than with addEventListener.
    els.frame.onclick = function () {
      if (!panelOpen) {
        openPanel();
      }
    };
    els.panelClose.onclick = closePanel;
    // This touch handler also lets iOS show the :active press states.
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
      setInterval(checkForNewServer, 60 * 1000);
      showNextSlide();
    });
  }

  init();
}());
