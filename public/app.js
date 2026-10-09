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
  var STATE_POLL_MS = 5 * 1000;              // refresh Home Assistant tiles while the panel is open
  var STALL_MS = 5 * 60 * 1000;              // reload if no new photo has appeared for this long
  var DAILY_RELOAD_MS = 24 * 60 * 60 * 1000; // restart once a day to keep old iPad memory fresh
  var FAILED_FLASH_MS = 4 * 1000;            // how long a failed tap shows its error
  var PHOTOS_OFF_TEXT = 'Photos are off. Set IMMICH_URL and IMMICH_API_KEY on the server.';
  var HOME_OFF_TEXT = 'Home Assistant is off. Set HA_URL and HA_TOKEN on the server.';

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
  var tiles = {};
  var tilesBuilt = false;
  var refreshing = false;
  var panelOpen = false;
  var panelPoll = null;
  var panelIdleTimer = null;

  function byId(id) {
    return document.getElementById(id);
  }

  // XMLHttpRequest rather than fetch, so it works on every iOS 12 Safari.
  function request(method, url, callback) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.timeout = 15000;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) {
        return;
      }
      var body = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch (e) {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        callback(null, body);
      } else {
        callback((body && body.error) || 'Request failed (' + (xhr.status || 'no response') + ')', body);
      }
    };
    xhr.send(null);
  }

  function loadConfig(done) {
    request('GET', 'api/config', function (err, body) {
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

  function capitalize(text) {
    text = String(text || '');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function showMessage(text) {
    els.message.textContent = text || '';
    els.message.className = text ? 'message' : 'message hidden';
  }

  function setPanelNote(text) {
    els.panelNote.textContent = text || '';
    els.panelNote.className = text ? 'panel-note' : 'panel-note hidden';
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
    request('GET', 'api/photos', function (err, body) {
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

  function openPanel() {
    panelOpen = true;
    els.panel.className = 'panel';
    refreshStates();
    panelPoll = setInterval(refreshStates, STATE_POLL_MS);
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

  // Every tap in the panel restarts the countdown back to the photos.
  function touchPanel() {
    clearTimeout(panelIdleTimer);
    panelIdleTimer = setTimeout(closePanel, config.panelIdleSeconds * 1000);
  }

  function refreshStates() {
    if (refreshing) {
      return;
    }
    refreshing = true;
    request('GET', 'api/ha/entities', function (err, body) {
      refreshing = false;
      if (err) {
        setPanelNote(err);
        return;
      }
      if (!body || !body.configured) {
        setPanelNote(HOME_OFF_TEXT);
        return;
      }
      var entities = body.entities || [];
      if (!tilesBuilt) {
        buildTiles(entities);
      }
      setPanelNote(entities.length ? '' : 'No entities listed. Set HA_ENTITIES on the server.');
      for (var i = 0; i < entities.length; i++) {
        updateTile(entities[i]);
      }
    });
  }

  function buildTiles(entities) {
    tilesBuilt = true;
    for (var i = 0; i < entities.length; i++) {
      var entity = entities[i];
      var isInfo = entity.kind === 'info';
      var el = document.createElement(isInfo ? 'div' : 'button');
      if (!isInfo) {
        el.type = 'button';
        el.onclick = makeTapHandler(entity.entity_id);
      }
      var nameEl = document.createElement('div');
      nameEl.className = 'tile-name';
      var statusEl = document.createElement('div');
      statusEl.className = 'tile-status';
      el.appendChild(nameEl);
      el.appendChild(statusEl);
      els.tiles.appendChild(el);
      tiles[entity.entity_id] = { el: el, nameEl: nameEl, statusEl: statusEl, entity: null, busy: false, flash: '' };
    }
  }

  function makeTapHandler(entityId) {
    return function () {
      runAction(entityId);
    };
  }

  function updateTile(entity) {
    var tile = tiles[entity.entity_id];
    if (tile) {
      tile.entity = entity;
      renderTile(tile);
    }
  }

  function renderTile(tile) {
    var entity = tile.entity;
    if (!entity) {
      return;
    }
    var classes = ['tile'];
    var status;
    if (!entity.available) {
      status = 'Unavailable';
      classes.push('is-unavailable');
    } else if (entity.kind === 'toggle') {
      status = capitalize(entity.state);
      classes.push(entity.on ? 'is-on' : 'is-off');
    } else if (entity.kind === 'press') {
      status = 'Tap to run';
    } else {
      status = capitalize(entity.state) + (entity.unit ? ' ' + entity.unit : '');
      classes.push('is-info');
    }
    if (tile.flash) {
      status = tile.flash;
      classes.push('is-failed');
    }
    if (tile.busy) {
      classes.push('is-busy');
    }
    tile.el.className = classes.join(' ');
    tile.nameEl.textContent = entity.name;
    tile.statusEl.textContent = status;
    if (entity.kind !== 'info') {
      tile.el.disabled = !entity.available || tile.busy;
    }
  }

  function runAction(entityId) {
    var tile = tiles[entityId];
    if (!tile || tile.busy) {
      return;
    }
    touchPanel();
    tile.busy = true;
    tile.flash = '';
    renderTile(tile);

    request('POST', 'api/ha/entities/' + encodeURIComponent(entityId) + '/action', function (err, body) {
      tile.busy = false;
      if (err) {
        tile.flash = err;
        setTimeout(function () {
          tile.flash = '';
          renderTile(tile);
        }, FAILED_FLASH_MS);
      } else if (body && body.entity) {
        tile.entity = body.entity;
      }
      renderTile(tile);
      // Home Assistant can take a moment to report the new state.
      setTimeout(function () {
        if (panelOpen) {
          refreshStates();
        }
      }, 1500);
    });
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
    els.tiles = byId('tiles');
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
