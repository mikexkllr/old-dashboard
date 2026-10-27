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
  var QUICK_FADE_MS = 400;                   // the faster .is-quick fade after a swipe
  var SWIPE_MIN_PX = 50;                     // shortest sideways move that counts as a swipe
  var HISTORY_SIZE = 30;                     // photos a swipe to the right can go back through
  var CONTROLS_POLL_MS = 5 * 1000;           // refresh Home Assistant while the panel is open
  var REFRESH_AFTER_COMMAND_MS = 1500;       // Home Assistant can take a moment to report a change
  var STALL_MS = 5 * 60 * 1000;              // reload if no new photo has appeared for this long past its time
  var DAILY_RELOAD_MS = 24 * 60 * 60 * 1000; // restart once a day to keep old iPad memory fresh
  var FLASH_MS = 4 * 1000;                   // how long a failed action shows its error
  var SETTINGS_IDLE_MS = 5 * 60 * 1000;      // the settings menu waits longer before returning to the photos
  var MATCH_CHECK_DELAY_MS = 400;            // wait for a pause in filter changes before counting photos
  var RESET_CONFIRM_MS = 4 * 1000;           // a second tap on Reset within this time confirms it
  var FIRST_YEAR = 1950;                     // the earliest year the photo filter offers
  var PHOTOS_OFF_TEXT = 'Photos are off. Set IMMICH_URL and IMMICH_API_KEY on the server.';
  var HOME_OFF_TEXT = 'Home Assistant is off. Set HA_URL and HA_TOKEN on the server.';

  // Everything the settings menu changes. The rest of the config comes from the server only.
  var SETTING_KEYS = ['intervalSeconds', 'photoFit', 'showClock', 'showCaptions', 'panelIdleSeconds',
    'albumIds', 'personIds', 'favoritesOnly', 'fromYear', 'toYear', 'hiddenEntities'];
  var PHOTO_FILTER_KEYS = ['albumIds', 'personIds', 'favoritesOnly', 'fromYear', 'toYear'];
  var INTERVAL_CHOICES = [10, 15, 20, 30, 45, 60, 120, 180, 300, 600, 900, 1800, 3600];
  var IDLE_CHOICES = [15, 30, 60, 120, 180, 300, 600, 1800, 3600];
  var FIT_CHOICES = [['auto', 'Auto'], ['cover', 'Fill screen'], ['contain', 'Whole photo']];

  // Colour choices for lights: white tones by colour temperature, and colours by hue.
  var WHITE_PRESETS = [
    { label: 'Warm', kelvin: 2700 },
    { label: 'Neutral', kelvin: 4000 },
    { label: 'Daylight', kelvin: 6000 }
  ];
  var COLOR_PRESETS = [
    { label: 'Red', hue: 0 },
    { label: 'Orange', hue: 28 },
    { label: 'Yellow', hue: 50 },
    { label: 'Green', hue: 120 },
    { label: 'Turquoise', hue: 170 },
    { label: 'Blue', hue: 225 },
    { label: 'Purple', hue: 275 },
    { label: 'Pink', hue: 320 }
  ];
  var GROUP_MIN_KELVIN = 2000;
  var GROUP_MAX_KELVIN = 6500;

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
    play: 'M7 4.5v15L19.5 12z',
    sliders: 'M4 7h7M15 7h5M4 17h3M11 17h9M15 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM11 17a2 2 0 1 1-4 0 2 2 0 0 1 4 0z',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    chevron: 'M7 10l5 5 5-5'
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

  // Defaults. The server's /api/config overrides them, and the settings menu changes them.
  var config = {
    intervalSeconds: 60,
    photoFit: 'auto',
    showClock: true,
    showCaptions: true,
    panelIdleSeconds: 60,
    albumIds: [],
    personIds: [],
    favoritesOnly: false,
    fromYear: null,
    toYear: null,
    hiddenEntities: [],
    photosEnabled: true,
    homeAssistantEnabled: true
  };
  var settingsRevision = null;
  var appliedFilters = '';   // the photo filters the server last confirmed
  var filterVersion = 0;     // changes with the filters, so a playlist fetched before is dropped

  var els = {};
  var slides = [];      // two layers that take turns: { el, fill, photo }
  var activeSlide = 0;
  var fadeTimer = null;
  var pendingLoad = null; // the photo still loading, so a newer one can cancel it
  var playlist = [];
  var playlistIndex = 0;
  var playlistMore = false; // Immich had more matching photos than one batch
  var fetchingPlaylist = false;
  var shown = [];       // photos shown so far, oldest first, so a swipe can go back
  var shownPos = -1;    // the one on screen
  var swipeStart = null; // where the current touch on the frame began
  var swipedAt = 0;
  var hasShownPhoto = false;
  var startedAt = Date.now();
  var lastShownAt = Date.now(); // also set when Immich answers that no photo matches
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
  var lightQueue = [];  // whole-room and whole-home light commands, sent one at a time
  var lightBusy = false;

  // Colour sheet state. The target is { entityId } or { areaId, title, lightIds }.
  var sheetTarget = null;
  var sheetSelected = null;

  // Settings menu state
  var settingsOpen = false;
  var settingsState = null;  // the last answer from api/settings
  var settingRows = [];      // each row's update(), run after every change
  var settingsEls = {};
  var choices = {};          // albums, people and entities, each { items, error }
  var pendingSettings = {};  // changes not yet sent to the server
  var savingSettings = false;
  var matchTimer = null;
  var filtersDirty = false;  // the filters changed, so show a matching photo on leaving
  var entityListOpen = false;
  var resetArmed = false;
  var resetTimer = null;

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

  function clampByte(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
  }

  // A fully saturated colour for a hue from 0 to 360.
  function hueToRgb(hue) {
    var h = (hue % 360) / 60;
    var x = 1 - Math.abs((h % 2) - 1);
    var parts = h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x]
      : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
    return [clampByte(parts[0] * 255), clampByte(parts[1] * 255), clampByte(parts[2] * 255)];
  }

  // An approximate colour for a white tone, for the swatches and the slider.
  function kelvinToRgb(kelvin) {
    var t = kelvin / 100;
    var r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
    var g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    var b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    return [clampByte(r), clampByte(g), clampByte(b)];
  }

  function cssColor(rgb) {
    return 'rgb(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ')';
  }

  function plural(count, one, many) {
    return count === 1 ? '1 ' + one : count + ' ' + many;
  }

  // 1234567 reads as 1,234,567.
  function formatCount(count) {
    return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function formatDuration(seconds) {
    if (seconds % 3600 === 0) {
      return plural(seconds / 3600, 'hour', 'hours');
    }
    if (seconds % 60 === 0) {
      return plural(seconds / 60, 'minute', 'minutes');
    }
    return plural(seconds, 'second', 'seconds');
  }

  function copyList(list) {
    return list ? list.slice() : [];
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
        settingsRevision = body.settingsRevision;
      }
      if (body && body.startedAt) {
        serverStartedAt = body.startedAt;
      }
      appliedFilters = filterKey();
      done();
    });
  }

  function filterKey() {
    var parts = [];
    for (var i = 0; i < PHOTO_FILTER_KEYS.length; i++) {
      parts.push(config[PHOTO_FILTER_KEYS[i]]);
    }
    return JSON.stringify(parts);
  }

  function filtersActive() {
    return config.albumIds.length > 0 || config.personIds.length > 0 || config.favoritesOnly
      || config.fromYear !== null || config.toYear !== null;
  }

  // Takes settings the server confirmed, from this screen or another one.
  function adoptSettings(settings, revision) {
    for (var i = 0; i < SETTING_KEYS.length; i++) {
      var key = SETTING_KEYS[i];
      if (settings.hasOwnProperty(key)) {
        config[key] = settings[key];
      }
    }
    settingsRevision = revision;
    applyFrameSettings();
    var filters = filterKey();
    if (filters !== appliedFilters) {
      appliedFilters = filters;
      filtersChanged();
    }
    updateSettingRows();
  }

  // The next photo comes from the new filters. The menu counts the matches.
  function filtersChanged() {
    filterVersion++;
    playlist = [];
    playlistIndex = 0;
    playlistMore = false;
    if (settingsOpen) {
      filtersDirty = true;
      scheduleMatchCheck();
    }
  }

  var shownInterval = null;

  // Applies the frame settings at once, without waiting for the next photo.
  function applyFrameSettings() {
    setClass(els.clock, config.showClock ? 'clock' : 'clock hidden');
    refitVisibleSlide();
    showCaption(shownPos >= 0 ? shown[shownPos] : null);
    if (shownInterval !== null && shownInterval !== config.intervalSeconds && hasShownPhoto && !pendingLoad) {
      scheduleNextSlide(config.intervalSeconds * 1000);
    }
    shownInterval = config.intervalSeconds;
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

  function noPhotosText() {
    return filtersActive() ? 'No photos match the photo filters in Settings.' : 'No photos found in Immich yet.';
  }

  // A batch fetched before the filters changed is dropped, and fetched again.
  function fetchPlaylist(callback) {
    var version = filterVersion;
    request('GET', 'api/photos', null, function (err, body) {
      if (version !== filterVersion) {
        fetchPlaylist(callback);
        return;
      }
      var photos = body && body.photos ? body.photos : [];
      if (photos.length === 0) {
        // Nothing matching is an answer, not a stall, so the watchdog leaves it be.
        if (!err) {
          lastShownAt = Date.now();
        }
        callback(err || noPhotosText());
        return;
      }
      playlist = photos;
      playlistIndex = 0;
      playlistMore = Boolean(body.more);
      callback(null);
    });
  }

  function scheduleNextSlide(delayMs) {
    clearTimeout(slideTimer);
    slideTimer = setTimeout(function () {
      showNextSlide(false);
    }, delayMs);
  }

  // quick is true for a swipe, which gets a shorter fade than the timer.
  function showNextSlide(quick) {
    clearTimeout(slideTimer);
    if (!config.photosEnabled) {
      showMessage(PHOTOS_OFF_TEXT);
      return;
    }
    // After a swipe back, go forward through the photos already seen.
    if (shownPos < shown.length - 1) {
      loadPhoto(shown[shownPos + 1], shownPos + 1, quick);
      return;
    }
    if (playlistIndex < playlist.length) {
      loadPhoto(playlist[playlistIndex++], -1, quick);
      return;
    }
    if (fetchingPlaylist) {
      return;
    }
    fetchingPlaylist = true;
    fetchPlaylist(function (err) {
      fetchingPlaylist = false;
      if (err) {
        // Filters that match nothing would otherwise leave one photo up for good.
        if (!hasShownPhoto || filtersActive()) {
          showMessage(err);
        }
        scheduleNextSlide(RETRY_MS);
        return;
      }
      loadPhoto(playlist[playlistIndex++], -1, quick);
    });
  }

  function showPreviousSlide() {
    if (!config.photosEnabled || shownPos <= 0) {
      return;
    }
    clearTimeout(slideTimer);
    loadPhoto(shown[shownPos - 1], shownPos - 1, true);
  }

  // A swipe can start a new photo while the last one is still fading in.
  // Finishing that fade at once covers the slide underneath, so the new
  // photo loads into it unseen.
  function settleFade() {
    if (fadeTimer === null) {
      return;
    }
    clearTimeout(fadeTimer);
    fadeTimer = null;
    slides[activeSlide].el.className = 'slide is-front is-settled';
    slides[1 - activeSlide].el.className = 'slide';
  }

  // The photo loads into the slide that is not showing, then fades in.
  // position is its place in `shown`, or -1 for a photo not shown before.
  // A newer load cancels one still in progress.
  function loadPhoto(photo, position, quick) {
    if (pendingLoad) {
      pendingLoad.cancel();
    }
    settleFade();
    var incoming = slides[1 - activeSlide];
    var img = incoming.photo;
    var url = 'api/photos/' + encodeURIComponent(photo.id) + '/image';
    var finished = false;
    var guard = null;
    var load = {
      cancel: function () {
        stop();
      }
    };
    pendingLoad = load;

    function stop() {
      finished = true;
      clearTimeout(guard);
      img.onload = null;
      img.onerror = null;
      if (pendingLoad === load) {
        pendingLoad = null;
      }
    }

    function finish(ok) {
      if (finished) {
        return;
      }
      stop();
      if (ok) {
        showPhoto(incoming, photo, position, quick);
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

  function showPhoto(slide, photo, position, quick) {
    var outgoing = slides[activeSlide];
    applyFit(slide);

    if (position === -1) {
      shown.push(photo);
      if (shown.length > HISTORY_SIZE) {
        shown.shift();
      }
      shownPos = shown.length - 1;
    } else {
      shownPos = position;
    }

    // The old photo stays fully visible underneath while the new one fades in
    // on top, so the picture never dips towards black halfway.
    outgoing.el.className = 'slide is-back';
    slide.el.className = 'slide';
    // Reading a layout value applies the transparent state first, so the
    // fade always starts from nothing.
    void slide.el.offsetWidth;
    slide.el.className = quick ? 'slide is-front is-quick' : 'slide is-front';
    activeSlide = 1 - activeSlide;

    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(function () {
      fadeTimer = null;
      if (slides[activeSlide] !== outgoing) {
        outgoing.el.className = 'slide';
      }
    }, (quick ? QUICK_FADE_MS : FADE_MS) + 200);

    hasShownPhoto = true;
    lastShownAt = Date.now();
    showMessage('');

    showCaption(photo);
    scheduleNextSlide(config.intervalSeconds * 1000);
  }

  function showCaption(photo) {
    var caption = photo && config.showCaptions ? formatTakenAt(photo.takenAt) : '';
    setText(els.caption, caption);
    setClass(els.caption, caption ? 'caption' : 'caption hidden');
  }

  // A swipe left shows the next photo, and a swipe right the one before.
  // Anything else, such as a tap, is left to the click that opens the panel.
  function onFrameTouchStart(event) {
    var touch = event.touches[0];
    swipeStart = event.touches.length === 1 ? { x: touch.clientX, y: touch.clientY } : null;
  }

  function onFrameTouchEnd(event) {
    var start = swipeStart;
    swipeStart = null;
    if (!start || panelOpen) {
      return;
    }
    var touch = event.changedTouches[0];
    var dx = touch.clientX - start.x;
    var dy = touch.clientY - start.y;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < 2 * Math.abs(dy)) {
      return;
    }
    // A swipe is not a tap, so it must not open the panel as well.
    event.preventDefault();
    swipedAt = Date.now();
    if (dx < 0) {
      showNextSlide(true);
    } else {
      showPreviousSlide();
    }
  }

  // Restarts the page when the slideshow has silently stalled, and once a day.
  // It never interrupts someone using the home panel.
  function watchdog() {
    if (panelOpen) {
      return;
    }
    var now = Date.now();
    var stalled = config.photosEnabled && now - lastShownAt > config.intervalSeconds * 1000 + STALL_MS;
    if (stalled || now - startedAt > DAILY_RELOAD_MS) {
      window.location.reload();
    }
  }

  // A redeploy starts a new server with a new start time. Reloading then picks up
  // the new code. Settings changed on another screen are taken over as they are.
  // Both wait until nobody is using the home panel.
  function checkServer() {
    if (panelOpen) {
      return;
    }
    request('GET', 'api/config', null, function (err, body) {
      if (err || !body || !body.startedAt || panelOpen) {
        return;
      }
      if (serverStartedAt === null) {
        serverStartedAt = body.startedAt;
      } else if (body.startedAt !== serverStartedAt) {
        window.location.reload();
        return;
      }
      if (body.settingsRevision !== settingsRevision) {
        adoptSettings(body, body.settingsRevision);
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
    closeColorSheet();
    closeSettings();
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
    var idleMs = config.panelIdleSeconds * 1000;
    panelIdleTimer = setTimeout(closePanel, settingsOpen ? Math.max(idleMs, SETTINGS_IDLE_MS) : idleMs);
  }

  // The settings menu covers the controls, so they are not refreshed under it.
  function refreshControls() {
    if (refreshing || settingsOpen) {
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
    renderSheet();

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
    var allLightIds = [];
    for (var i = 0; i < list.length; i++) {
      var entity = list[i];
      var key = entity.area_id || '';
      if (!roomInfo[key]) {
        roomInfo[key] = { title: entity.area || 'No room', entities: [] };
        rooms.push(key);
      }
      roomInfo[key].entities.push(entity);
      categories[entity.category] = true;
      if (entity.domain === 'light') {
        allLightIds.push(entity.entity_id);
      }
    }

    if (list.length > 0) {
      addTab('rooms', 'Rooms', buildSection(rooms, roomInfo, null, allLightIds));
    }
    for (var c = 0; c < CATEGORY_ORDER.length; c++) {
      var name = CATEGORY_ORDER[c];
      if (categories[name]) {
        addTab(name, CATEGORY_LABELS[name], buildSection(rooms, roomInfo, name, allLightIds));
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
  // says which ceiling. A category tab leaves out the other categories. The
  // Rooms and Lights tabs start with buttons for every light in the home.
  function buildSection(rooms, roomInfo, category, allLightIds) {
    var section = createEl('div', 'section hidden');
    if ((category === null || category === 'lights') && allLightIds.length > 1) {
      section.appendChild(buildRoomHead(null, 'All lights', allLightIds, 'room room-all'));
    }
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
    // Lights without a room have no area to send a command to.
    var room = buildRoomHead(areaId === '' ? undefined : areaId, title, lightIds, 'room');
    var tiles = createEl('div', 'tiles');
    for (var i = 0; i < ids.length; i++) {
      tiles.appendChild(buildView(ids[i]).el);
    }
    room.appendChild(tiles);
    return room;
  }

  // The heading of a room: its name, how many lights are on, and buttons for
  // all its lights. areaId is null for every light in the home, and undefined
  // for a group that gets no buttons.
  function buildRoomHead(areaId, title, lightIds, className) {
    var room = createEl('div', className);
    var head = createEl('div', 'room-head');
    var titles = createEl('div', 'room-titles');
    titles.appendChild(createEl('div', 'room-title', title));
    var roomView = {
      lightIds: lightIds,
      all: areaId === null,
      summaryEl: createEl('div', 'room-summary'),
      onButton: null,
      offButton: null
    };
    titles.appendChild(roomView.summaryEl);
    head.appendChild(titles);

    if (areaId !== undefined && lightIds.length > 0) {
      var actions = createEl('div', 'room-actions');
      roomView.onButton = makeRoomButton('bulb', 'All on', function () {
        commandLights(areaId, lightIds, 'on');
      });
      roomView.offButton = makeRoomButton('power', 'All off', function () {
        commandLights(areaId, lightIds, 'off');
      });
      actions.appendChild(roomView.onButton);
      actions.appendChild(roomView.offButton);
      if (colorChoicesFor(lightIds).white) {
        actions.appendChild(makeColorButton('room-color', 'Colour for ' + title, function () {
          openColorSheet({ areaId: areaId, title: title, lightIds: lightIds });
        }));
      }
      head.appendChild(actions);
    }
    room.appendChild(head);
    roomViews.push(roomView);
    renderRoom(roomView);
    return room;
  }

  // "2 lights on" under the room name. All on shows while a light is off, and
  // All off while one is on.
  function renderRoom(roomView) {
    if (roomView.lightIds.length === 0) {
      return;
    }
    var on = 0;
    var off = 0;
    for (var i = 0; i < roomView.lightIds.length; i++) {
      var entity = entities[roomView.lightIds[i]];
      if (entity && entity.on) {
        on++;
      } else if (entity && entity.available) {
        off++;
      }
    }
    var total = roomView.lightIds.length;
    var summary;
    if (on === 0) {
      summary = 'All lights off';
    } else if (roomView.all) {
      summary = on === total ? 'All ' + total + ' lights on' : on + ' of ' + total + ' lights on';
    } else {
      summary = plural(on, 'light on', 'lights on');
    }
    setText(roomView.summaryEl, summary);
    if (roomView.onButton) {
      setClass(roomView.onButton, off > 0 ? 'room-button' : 'room-button hidden');
      setClass(roomView.offButton, on > 0 ? 'room-button' : 'room-button hidden');
    }
  }

  function renderRooms() {
    for (var i = 0; i < roomViews.length; i++) {
      renderRoom(roomViews[i]);
    }
  }

  function makeRoomButton(icon, label, onclick) {
    var button = createEl('button', 'room-button');
    button.type = 'button';
    button.title = label;
    button.appendChild(makeIcon(icon));
    button.appendChild(createEl('span', 'room-button-label', label));
    button.onclick = onclick;
    return button;
  }

  // A round button that shows a colour. Until it knows one, it shows a rainbow.
  function makeColorButton(className, label, onclick) {
    var button = createEl('button', className);
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.appendChild(createEl('span', 'swatch is-rainbow'));
    button.onclick = onclick;
    return button;
  }

  // The colours a set of lights can take. Every light with a colour can also
  // take a white tone, so white is offered whenever colour is.
  function colorChoicesFor(lightIds) {
    var result = { color: false, white: false, count: 0 };
    for (var i = 0; i < lightIds.length; i++) {
      var entity = entities[lightIds[i]];
      if (entity && entity.commands.indexOf('color_temp') !== -1) {
        result.white = true;
        result.count++;
        if (entity.commands.indexOf('color') !== -1) {
          result.color = true;
        }
      }
    }
    return result;
  }

  // Shows the change straight away. The refresh after the command corrects it.
  function guessLights(lightIds, command) {
    for (var i = 0; i < lightIds.length; i++) {
      var entity = entities[lightIds[i]];
      if (!entity || !entity.available || command === 'color' || command === 'color_temp') {
        continue;
      }
      entity.on = command === 'on';
      entity.state = command;
      if (entity.brightness !== null && entity.brightness !== undefined) {
        entity.brightness = command === 'on' ? null : 0;
      }
      renderEntity(lightIds[i]);
    }
  }

  // areaId is null for every light in the home. A colour replaces one still
  // waiting for the same room, so dragging through colours sends only the last.
  function commandLights(areaId, lightIds, command, value) {
    touchPanel();
    var body = { command: command };
    if (value !== undefined) {
      body.value = value;
    }
    if (areaId !== null) {
      body.area = areaId;
    }
    var last = lightQueue[lightQueue.length - 1];
    var isColor = command === 'color' || command === 'color_temp';
    if (last && last.area === body.area && isColor && (last.command === 'color' || last.command === 'color_temp')) {
      lightQueue[lightQueue.length - 1] = body;
    } else {
      lightQueue.push(body);
    }
    guessLights(lightIds, command);
    sendNextLights();
  }

  function sendNextLights() {
    if (lightBusy || lightQueue.length === 0) {
      return;
    }
    lightBusy = true;
    request('POST', 'api/ha/lights', lightQueue.shift(), function (err) {
      lightBusy = false;
      if (err) {
        setPanelNote(err);
        setSheetNote(err);
      }
      if (lightQueue.length > 0) {
        sendNextLights();
        return;
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
      entityUi[entityId] = {
        busy: false,
        flash: '',
        pendingBrightness: undefined,
        pendingTarget: undefined,
        pendingColor: '',
        queued: null
      };
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
      swatchEl: null,
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
      // Lights with colours or white tones get a colour button beside the slider.
      if (entity.commands.indexOf('color_temp') !== -1) {
        foot.className = 'tile-foot has-color';
        var colorButton = makeColorButton('color-button', 'Colour', function () {
          openColorSheet({ entityId: entityId });
        });
        view.swatchEl = colorButton.firstChild;
        view.controls.push(colorButton);
        foot.appendChild(colorButton);
      }
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

  // The colour a light shows: a colour just picked, else the one Home Assistant
  // reports while the light is on. Empty when there is none to show.
  function colorShown(entity, ui) {
    if (ui.pendingColor) {
      return ui.pendingColor;
    }
    return entity.on && entity.color && entity.color.rgb ? cssColor(entity.color.rgb) : '';
  }

  function renderSwatch(swatchEl, color) {
    setClass(swatchEl, color ? 'swatch' : 'swatch is-rainbow');
    if (swatchEl.style.backgroundColor !== color) {
      swatchEl.style.backgroundColor = color;
    }
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
    if (view.swatchEl) {
      renderSwatch(view.swatchEl, colorShown(entity, ui));
    }
  }

  function renderEntity(entityId) {
    for (var i = 0; i < views.length; i++) {
      if (views[i].entityId === entityId) {
        renderView(views[i]);
      }
    }
    renderRooms();
    if (sheetTarget && sheetTarget.entityId === entityId) {
      renderSheet();
    }
  }

  // A colour picked while the light is still busy waits, and replaces any
  // colour waiting before it, so the last one picked always arrives.
  function commandEntity(entityId, command, value, shownColor) {
    var ui = uiFor(entityId);
    if (ui.busy) {
      if (command === 'color' || command === 'color_temp') {
        ui.queued = { command: command, value: value, shownColor: shownColor };
        ui.pendingColor = shownColor;
        renderEntity(entityId);
      }
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
    if (shownColor) {
      ui.pendingColor = shownColor;
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
      ui.pendingColor = '';
      if (ui.queued) {
        var next = ui.queued;
        ui.queued = null;
        if (response && response.entity) {
          entities[entityId] = response.entity;
        }
        commandEntity(entityId, next.command, next.value, next.shownColor);
        return;
      }
      if (err) {
        ui.flash = err;
        setSheetNote(err);
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

  // ---- Colour sheet ----------------------------------------------------

  // What the sheet changes: one light, or the lights of a room or the home.
  function sheetLightIds() {
    return sheetTarget.entityId ? [sheetTarget.entityId] : sheetTarget.lightIds;
  }

  function openColorSheet(target) {
    sheetTarget = target;
    sheetSelected = null;
    touchPanel();
    buildSheet();
    els.sheet.className = 'sheet-backdrop';
  }

  function closeColorSheet() {
    if (!sheetTarget) {
      return;
    }
    sheetTarget = null;
    els.sheet.className = 'sheet-backdrop hidden';
    els.sheetBody.innerHTML = '';
    setSheetNote('');
  }

  function setSheetNote(text) {
    els.sheetNote.textContent = text || '';
    els.sheetNote.className = text ? 'sheet-note' : 'sheet-note hidden';
  }

  // Sends a choice: { rgb } for a colour, or { kelvin } for a white tone.
  function applyColor(choice) {
    touchPanel();
    setSheetNote('');
    var command = choice.rgb ? 'color' : 'color_temp';
    var value = choice.rgb || choice.kelvin;
    var shownColor = cssColor(choice.rgb || kelvinToRgb(choice.kelvin));
    if (sheetTarget.entityId) {
      commandEntity(sheetTarget.entityId, command, value, shownColor);
    } else {
      sheetTarget.shownColor = shownColor;
      commandLights(sheetTarget.areaId, sheetTarget.lightIds, command, value);
      renderSheet();
    }
  }

  function buildSheet() {
    var available = colorChoicesFor(sheetLightIds());
    var body = els.sheetBody;
    body.innerHTML = '';
    var presets = [];

    function addPreset(row, label, rgb, choice) {
      var button = createEl('button', 'preset');
      button.type = 'button';
      var swatch = createEl('span', 'swatch');
      swatch.style.backgroundColor = cssColor(rgb);
      button.appendChild(swatch);
      button.appendChild(createEl('span', 'preset-label', label));
      var index = presets.length;
      button.onclick = function () {
        sheetSelected = index;
        applyColor(choice);
        renderPresets();
      };
      presets.push(button);
      row.appendChild(button);
    }

    function renderPresets() {
      for (var i = 0; i < presets.length; i++) {
        setClass(presets[i], i === sheetSelected ? 'preset is-selected' : 'preset');
      }
    }

    if (available.white) {
      body.appendChild(createEl('div', 'sheet-label', 'White'));
      var whites = createEl('div', 'presets');
      for (var w = 0; w < WHITE_PRESETS.length; w++) {
        var white = WHITE_PRESETS[w];
        addPreset(whites, white.label, kelvinToRgb(white.kelvin), { kelvin: white.kelvin });
      }
      body.appendChild(whites);
    }
    if (available.color) {
      body.appendChild(createEl('div', 'sheet-label', 'Colour'));
      var colors = createEl('div', 'presets');
      for (var c = 0; c < COLOR_PRESETS.length; c++) {
        var color = COLOR_PRESETS[c];
        addPreset(colors, color.label, hueToRgb(color.hue), { rgb: hueToRgb(color.hue) });
      }
      body.appendChild(colors);
      body.appendChild(buildSheetSlider('Any colour', 'track-hue', 0, 359, 1, function (hue) {
        return { rgb: hueToRgb(hue) };
      }, renderPresets));
    }
    if (available.white) {
      var range = whiteRange();
      var slider = buildSheetSlider('White tone', 'track-white', range.min, range.max, 50, function (kelvin) {
        return { kelvin: kelvin };
      }, renderPresets);
      // The track runs from the warmest tone the lights take to the coolest.
      var warm = cssColor(kelvinToRgb(range.min));
      var cool = cssColor(kelvinToRgb(range.max));
      slider.trackEl.style.backgroundImage = '-webkit-linear-gradient(left, ' + warm + ', ' + cool + ')';
      slider.trackEl.style.backgroundImage = 'linear-gradient(to right, ' + warm + ', ' + cool + ')';
      body.appendChild(slider);
    }
    renderSheet();
  }

  // One light's own white range, or the usual range for a group.
  function whiteRange() {
    var entity = sheetTarget.entityId ? entities[sheetTarget.entityId] : null;
    if (entity && entity.color) {
      return { min: entity.color.minKelvin, max: entity.color.maxKelvin };
    }
    return { min: GROUP_MIN_KELVIN, max: GROUP_MAX_KELVIN };
  }

  // A slider over a coloured track. Letting go sends the value.
  function buildSheetSlider(label, trackClass, min, max, step, toChoice, onPick) {
    var box = createEl('div', 'sheet-slider');
    var track = createEl('div', 'sheet-track ' + trackClass);
    box.appendChild(track);
    var input = createEl('input', 'slider-input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(Math.round((min + max) / 2));
    input.setAttribute('aria-label', label);
    input.oninput = touchPanel;
    input.onchange = function () {
      sheetSelected = null;
      onPick();
      applyColor(toChoice(parseInt(input.value, 10)));
    };
    box.appendChild(input);
    var wrap = createEl('div', 'sheet-control');
    wrap.appendChild(createEl('div', 'sheet-label', label));
    wrap.appendChild(box);
    wrap.trackEl = track;
    return wrap;
  }

  // The title, and the colour the light shows now, or the one last picked for a group.
  function renderSheet() {
    if (!sheetTarget) {
      return;
    }
    var available = colorChoicesFor(sheetLightIds());
    var kind = available.color ? 'Colour and white' : 'White tone';
    var color = '';
    if (sheetTarget.entityId) {
      var entity = entities[sheetTarget.entityId];
      if (!entity) {
        closeColorSheet();
        return;
      }
      setText(els.sheetTitle, entity.name);
      setText(els.sheetSub, kind + (entity.on ? '' : ' · picking one switches the light on'));
      color = colorShown(entity, uiFor(sheetTarget.entityId));
    } else {
      setText(els.sheetTitle, sheetTarget.title);
      setText(els.sheetSub, kind + ' for ' + plural(available.count, 'light', 'lights'));
      color = sheetTarget.shownColor || '';
    }
    renderSwatch(els.sheetSwatch, color);
  }

  // ---- Settings menu ----------------------------------------------------
  //
  // Every change is sent to the server at once and applies to the frame
  // straight away. The server keeps the settings for every screen.

  function isEmpty(object) {
    for (var key in object) {
      if (object.hasOwnProperty(key)) {
        return false;
      }
    }
    return true;
  }

  function setSettingsNote(text) {
    els.settingsNote.textContent = text || '';
    els.settingsNote.className = text ? 'panel-note' : 'panel-note hidden';
  }

  function openSettings() {
    closeColorSheet();
    settingsOpen = true;
    entityListOpen = false;
    choices = {};
    setSettingsNote('');
    els.settings.className = 'panel settings';
    // Two see-through layers would be hard to read, so the panel steps aside.
    els.panel.className = 'panel is-under';
    buildSettings();
    els.settingsContent.scrollTop = 0;
    touchPanel();
    request('GET', 'api/settings', null, function (err, body) {
      if (!settingsOpen) {
        return;
      }
      if (err || !body) {
        setSettingsNote(err || 'The settings could not be loaded.');
        return;
      }
      settingsState = body;
      adoptSettings(body.settings, body.revision);
      renderSettingsFooter();
    });
    if (config.photosEnabled) {
      loadChoices('albums', 'api/photos/albums');
      loadChoices('people', 'api/photos/people');
      scheduleMatchCheck();
    }
  }

  // Back to the home panel. A changed filter shows a matching photo right away.
  function closeSettings() {
    if (!settingsOpen) {
      return;
    }
    settingsOpen = false;
    clearTimeout(matchTimer);
    disarmReset();
    els.settings.className = 'panel settings hidden';
    if (panelOpen) {
      els.panel.className = 'panel';
    }
    els.settingsContent.innerHTML = '';
    settingRows = [];
    settingsEls = {};
    if (filtersDirty) {
      filtersDirty = false;
      showNextSlide(false);
    }
    if (panelOpen) {
      touchPanel();
      refreshControls();
    }
  }

  function loadChoices(name, url) {
    choices[name] = { items: null, error: '' };
    request('GET', url, null, function (err, body) {
      if (!settingsOpen) {
        return;
      }
      choices[name] = { items: err || !body ? null : body[name] || [], error: err || '' };
      if (name === 'entities') {
        buildEntityList();
      } else {
        buildChoiceList(name);
      }
    });
  }

  function changeSetting(patch) {
    touchPanel();
    var filters = false;
    for (var key in patch) {
      if (patch.hasOwnProperty(key)) {
        config[key] = patch[key];
        pendingSettings[key] = patch[key];
        if (PHOTO_FILTER_KEYS.indexOf(key) !== -1) {
          filters = true;
        }
      }
    }
    applyFrameSettings();
    if (filters) {
      clearTimeout(matchTimer);
      setMatchText('Checking photos...', false);
    }
    updateSettingRows();
    saveSettings();
  }

  // One request at a time, so changes arrive in order. Changes made meanwhile
  // go together in the next request.
  function saveSettings() {
    if (savingSettings || isEmpty(pendingSettings)) {
      return;
    }
    var patch = pendingSettings;
    pendingSettings = {};
    savingSettings = true;
    request('PUT', 'api/settings', patch, function (err, body) {
      savingSettings = false;
      if (err || !body) {
        setSettingsNote(err || 'The settings could not be saved.');
        resyncSettings();
      } else {
        setSettingsNote('');
        settingsState = body;
        // Newer changes are still on their way, so only the last answer is taken over.
        if (isEmpty(pendingSettings)) {
          adoptSettings(body.settings, body.revision);
        }
        renderSettingsFooter();
      }
      saveSettings();
    });
  }

  // After a refused change, the menu shows what the server really has.
  function resyncSettings() {
    request('GET', 'api/settings', null, function (err, body) {
      if (err || !body || savingSettings || !isEmpty(pendingSettings)) {
        return;
      }
      settingsState = body;
      adoptSettings(body.settings, body.revision);
      renderSettingsFooter();
      scheduleMatchCheck();
    });
  }

  function updateSettingRows() {
    for (var i = 0; i < settingRows.length; i++) {
      settingRows[i]();
    }
  }

  function setMatchText(text, problem) {
    if (settingsEls.match) {
      setText(settingsEls.match, text);
      setClass(settingsEls.match, problem ? 'setting-row setting-info is-problem' : 'setting-row setting-info');
    }
  }

  // Counts the photos that match, once the changes have reached the server.
  // The batch it fetches becomes the frame's next photos.
  function scheduleMatchCheck() {
    if (!config.photosEnabled || !settingsOpen) {
      return;
    }
    clearTimeout(matchTimer);
    setMatchText('Checking photos...', false);
    matchTimer = setTimeout(function () {
      if (savingSettings || !isEmpty(pendingSettings)) {
        scheduleMatchCheck();
        return;
      }
      fetchPlaylist(function (err) {
        if (!settingsOpen) {
          return;
        }
        if (err) {
          setMatchText(err, true);
        } else if (playlistMore) {
          setMatchText(formatCount(playlist.length) + '+ photos match', false);
        } else {
          setMatchText(plural(playlist.length, 'photo matches', 'photos match'), false);
        }
      });
    }, MATCH_CHECK_DELAY_MS);
  }

  function settingsGroup(title, hint) {
    var el = createEl('div', 'settings-group');
    if (title) {
      el.appendChild(createEl('div', 'settings-title', title));
    }
    var list = createEl('div', 'settings-list');
    el.appendChild(list);
    if (hint) {
      el.appendChild(createEl('div', 'settings-hint', hint));
    }
    return { el: el, list: list };
  }

  function infoRow(text, problem) {
    return createEl('div', problem ? 'setting-row setting-info is-problem' : 'setting-row setting-info', text);
  }

  function patchFor(key, value) {
    var patch = {};
    patch[key] = value;
    return patch;
  }

  // A row with a native picker, which iOS shows as a list to tap or a wheel.
  // An empty option value stands for null.
  function selectRow(label, key, options, toPatch) {
    var row = createEl('div', 'setting-row');
    row.appendChild(createEl('span', 'setting-label', label));
    var wrap = createEl('span', 'select-wrap');
    var select = createEl('select', 'setting-select');
    for (var i = 0; i < options.length; i++) {
      var option = createEl('option', null, options[i][1]);
      option.value = options[i][0] === null ? '' : String(options[i][0]);
      select.appendChild(option);
    }
    select.setAttribute('aria-label', label);
    select.onchange = function () {
      var value = select.value === '' ? null : parseInt(select.value, 10);
      changeSetting(toPatch ? toPatch(value) : patchFor(key, value));
    };
    wrap.appendChild(select);
    wrap.appendChild(makeIcon('chevron', 'icon select-icon'));
    row.appendChild(wrap);
    settingRows.push(function () {
      var value = config[key] === null ? '' : String(config[key]);
      if (select.value !== value) {
        select.value = value;
      }
    });
    return row;
  }

  function durationOptions(choicesList, current) {
    var seconds = choicesList.slice();
    if (seconds.indexOf(current) === -1) {
      seconds.push(current);
      seconds.sort(function (a, b) {
        return a - b;
      });
    }
    var options = [];
    for (var i = 0; i < seconds.length; i++) {
      options.push([seconds[i], formatDuration(seconds[i])]);
    }
    return options;
  }

  // A from or until year. Moving one past the other moves the other along,
  // so the range is never empty.
  function yearRow(label, key) {
    var newest = new Date().getFullYear();
    var years = [];
    for (var year = newest; year >= FIRST_YEAR; year--) {
      years.push(year);
    }
    if (config[key] !== null && years.indexOf(config[key]) === -1) {
      years.push(config[key]);
      years.sort(function (a, b) {
        return b - a;
      });
    }
    var options = [[null, 'Any year']];
    for (var i = 0; i < years.length; i++) {
      options.push([years[i], String(years[i])]);
    }
    return selectRow(label, key, options, function (value) {
      var patch = patchFor(key, value);
      if (value !== null && key === 'fromYear' && config.toYear !== null && value > config.toYear) {
        patch.toYear = value;
      }
      if (value !== null && key === 'toYear' && config.fromYear !== null && value < config.fromYear) {
        patch.fromYear = value;
      }
      return patch;
    });
  }

  function switchRow(label, key) {
    var row = createEl('button', 'setting-row');
    row.type = 'button';
    row.appendChild(createEl('span', 'setting-label', label));
    row.appendChild(makeSwitch());
    row.onclick = function () {
      changeSetting(patchFor(key, !config[key]));
    };
    settingRows.push(function () {
      setClass(row, config[key] ? 'setting-row is-on' : 'setting-row');
    });
    return row;
  }

  function segmentRow(label, key, options) {
    var row = createEl('div', 'setting-row');
    row.appendChild(createEl('span', 'setting-label', label));
    var group = createEl('span', 'segments');
    var buttons = [];
    for (var i = 0; i < options.length; i++) {
      var button = createEl('button', 'segment', options[i][1]);
      button.type = 'button';
      button.onclick = makeSegmentHandler(key, options[i][0]);
      group.appendChild(button);
      buttons.push(button);
    }
    row.appendChild(group);
    settingRows.push(function () {
      for (var b = 0; b < buttons.length; b++) {
        setClass(buttons[b], config[key] === options[b][0] ? 'segment is-active' : 'segment');
      }
    });
    return row;
  }

  function makeSegmentHandler(key, value) {
    return function () {
      changeSetting(patchFor(key, value));
    };
  }

  // A row to tap on and off, with a tick while it is chosen.
  function checkRow(label, detail, isChecked, onToggle) {
    var row = createEl('button', 'setting-row');
    row.type = 'button';
    row.appendChild(createEl('span', 'setting-label', label));
    if (detail) {
      row.appendChild(createEl('span', 'setting-detail', detail));
    }
    row.appendChild(makeIcon('check', 'icon setting-check'));
    row.onclick = function () {
      onToggle();
    };
    settingRows.push(function () {
      setClass(row, isChecked() ? 'setting-row is-checked' : 'setting-row');
    });
    return row;
  }

  function toggleInList(key, id) {
    var list = copyList(config[key]);
    var index = list.indexOf(id);
    if (index === -1) {
      list.push(id);
    } else {
      list.splice(index, 1);
    }
    changeSetting(patchFor(key, list));
  }

  function makeChoiceRow(key, item, detail) {
    return checkRow(item.name, detail, function () {
      return config[key].indexOf(item.id) !== -1;
    }, function () {
      toggleInList(key, item.id);
    });
  }

  // The album or people list. Choosing none shows every photo. A chosen one
  // that Immich no longer lists, such as a deleted album, can still be unticked.
  function buildChoiceList(name) {
    var list = settingsEls[name];
    if (!list) {
      return;
    }
    list.innerHTML = '';
    var albums = name === 'albums';
    var key = albums ? 'albumIds' : 'personIds';
    var state = choices[name];
    if (!state || (!state.items && !state.error)) {
      list.appendChild(infoRow(albums ? 'Loading albums...' : 'Loading people...'));
      return;
    }

    list.appendChild(checkRow(albums ? 'All photos' : 'Everyone', '', function () {
      return config[key].length === 0;
    }, function () {
      changeSetting(patchFor(key, []));
    }));
    if (state.error) {
      list.appendChild(infoRow(state.error, true));
    }
    var items = state.items || [];
    var known = {};
    for (var i = 0; i < items.length; i++) {
      known[items[i].id] = true;
      var item = items[i];
      var detail = '';
      if (albums && item.count !== null) {
        detail = (item.shared ? 'Shared · ' : '') + formatCount(item.count) + (item.count === 1 ? ' photo' : ' photos');
      }
      list.appendChild(makeChoiceRow(key, item, detail));
    }
    for (var j = 0; j < config[key].length; j++) {
      if (!known[config[key][j]]) {
        list.appendChild(makeChoiceRow(key, { id: config[key][j], name: albums ? 'Album not found' : 'Person not found' }, ''));
      }
    }
    if (items.length === 0 && !state.error) {
      list.appendChild(infoRow(albums ? 'Immich has no albums yet.' : 'Nobody has a name in Immich yet.'));
    }
    updateSettingRows();
  }

  function entityToggleRow() {
    var row = createEl('button', 'setting-row');
    row.type = 'button';
    row.appendChild(createEl('span', 'setting-label', 'Choose what the panel shows'));
    var detail = createEl('span', 'setting-detail');
    row.appendChild(detail);
    row.appendChild(makeIcon('chevron', 'icon setting-chevron'));
    row.onclick = function () {
      touchPanel();
      entityListOpen = !entityListOpen;
      if (entityListOpen && !choices.entities) {
        loadChoices('entities', 'api/settings/entities');
      }
      buildEntityList();
      updateSettingRows();
    };
    settingRows.push(function () {
      var hidden = config.hiddenEntities.length;
      setText(detail, hidden === 0 ? 'Everything' : hidden + ' hidden');
      setClass(row, entityListOpen ? 'setting-row is-open' : 'setting-row');
    });
    return row;
  }

  function entityRow(entity) {
    var row = createEl('button', 'setting-row');
    row.type = 'button';
    row.appendChild(createEl('span', 'setting-label', entity.name));
    row.appendChild(createEl('span', 'setting-detail', CATEGORY_LABELS[entity.category] || ''));
    row.appendChild(makeSwitch());
    row.onclick = function () {
      toggleInList('hiddenEntities', entity.entity_id);
    };
    settingRows.push(function () {
      setClass(row, config.hiddenEntities.indexOf(entity.entity_id) === -1 ? 'setting-row is-on' : 'setting-row');
    });
    return row;
  }

  // Every entity the panel can show, room by room, each with a switch.
  function buildEntityList() {
    var box = settingsEls.entities;
    if (!box) {
      return;
    }
    box.innerHTML = '';
    if (!entityListOpen) {
      return;
    }
    var state = choices.entities;
    if (!state || (!state.items && !state.error)) {
      var loading = settingsGroup('', '');
      loading.list.appendChild(infoRow('Loading entities...'));
      box.appendChild(loading.el);
      return;
    }
    if (state.error) {
      var failed = settingsGroup('', '');
      failed.list.appendChild(infoRow(state.error, true));
      box.appendChild(failed.el);
      return;
    }
    // The server sorts the entities by room, so each room is one run of them.
    var group = null;
    var groupArea = null;
    for (var i = 0; i < state.items.length; i++) {
      var entity = state.items[i];
      if (group === null || entity.area !== groupArea) {
        groupArea = entity.area;
        group = settingsGroup(entity.area || 'No room', '');
        box.appendChild(group.el);
      }
      group.list.appendChild(entityRow(entity));
    }
    updateSettingRows();
  }

  function resetRow() {
    var row = createEl('button', 'setting-row is-danger');
    row.type = 'button';
    var label = createEl('span', 'setting-label', 'Reset all settings');
    row.appendChild(label);
    settingsEls.resetLabel = label;
    row.onclick = function () {
      touchPanel();
      if (!resetArmed) {
        resetArmed = true;
        setText(label, 'Tap again to use the server settings');
        resetTimer = setTimeout(disarmReset, RESET_CONFIRM_MS);
        return;
      }
      disarmReset();
      pendingSettings = {};
      request('DELETE', 'api/settings', null, function (err, body) {
        if (err || !body) {
          setSettingsNote(err || 'The settings could not be reset.');
          return;
        }
        setSettingsNote('');
        settingsState = body;
        adoptSettings(body.settings, body.revision);
        renderSettingsFooter();
      });
    };
    return row;
  }

  function disarmReset() {
    resetArmed = false;
    clearTimeout(resetTimer);
    if (settingsEls.resetLabel) {
      setText(settingsEls.resetLabel, 'Reset all settings');
    }
  }

  // Says which settings come from the menu, and whether they outlast a restart.
  function renderSettingsFooter() {
    var footer = settingsEls.footer;
    if (!footer || !settingsState) {
      return;
    }
    var changed = settingsState.changed.length;
    var lines = [changed === 0
      ? 'Every setting has the value set on the server.'
      : plural(changed, 'setting was', 'settings were') + ' changed here. Reset goes back to the values set on the server.'];
    lines.push(settingsState.saved
      ? 'Changes are saved on the dashboard server, so every screen uses them.'
      : settingsState.problem);
    setText(footer, lines.join(' '));
    setClass(footer, settingsState.saved ? 'settings-footer' : 'settings-footer is-problem');
  }

  function buildSettings() {
    var content = els.settingsContent;
    content.innerHTML = '';
    settingRows = [];
    settingsEls = {};

    if (config.photosEnabled) {
      var photos = settingsGroup('Photos', 'Only photos taken in these years are shown. Changes apply from the next photo.');
      photos.list.appendChild(yearRow('From', 'fromYear'));
      photos.list.appendChild(yearRow('Until', 'toYear'));
      photos.list.appendChild(switchRow('Favourites only', 'favoritesOnly'));
      settingsEls.match = infoRow('Checking photos...');
      photos.list.appendChild(settingsEls.match);
      content.appendChild(photos.el);

      var albums = settingsGroup('Albums', 'Choose albums to show only their photos.');
      settingsEls.albums = albums.list;
      content.appendChild(albums.el);
      buildChoiceList('albums');

      var people = settingsGroup('People', 'Choose people to show only photos of them. People without a name in Immich are not listed.');
      settingsEls.people = people.list;
      content.appendChild(people.el);
      buildChoiceList('people');
    } else {
      var off = settingsGroup('Photos', '');
      off.list.appendChild(infoRow(PHOTOS_OFF_TEXT));
      content.appendChild(off.el);
    }

    var slideshow = settingsGroup('Slideshow', '');
    slideshow.list.appendChild(selectRow('Time per photo', 'intervalSeconds',
      durationOptions(INTERVAL_CHOICES, config.intervalSeconds)));
    slideshow.list.appendChild(segmentRow('Photo size', 'photoFit', FIT_CHOICES));
    slideshow.list.appendChild(switchRow('Clock', 'showClock'));
    slideshow.list.appendChild(switchRow('Date taken', 'showCaptions'));
    content.appendChild(slideshow.el);

    var home = settingsGroup('Home panel', '');
    home.list.appendChild(selectRow('Back to photos after', 'panelIdleSeconds',
      durationOptions(IDLE_CHOICES, config.panelIdleSeconds)));
    if (config.homeAssistantEnabled) {
      home.list.appendChild(entityToggleRow());
    }
    content.appendChild(home.el);
    if (config.homeAssistantEnabled) {
      settingsEls.entities = createEl('div', 'settings-entities');
      content.appendChild(settingsEls.entities);
    }

    var reset = settingsGroup('', '');
    reset.list.appendChild(resetRow());
    content.appendChild(reset.el);

    settingsEls.footer = createEl('div', 'settings-footer');
    content.appendChild(settingsEls.footer);
    renderSettingsFooter();
    updateSettingRows();
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
    els.panelSettings = byId('panel-settings');
    els.tabs = byId('tabs');
    els.content = byId('content');
    els.settings = byId('settings');
    els.settingsDone = byId('settings-done');
    els.settingsNote = byId('settings-note');
    els.settingsContent = byId('settings-content');
    els.sheet = byId('sheet');
    els.sheetSwatch = byId('sheet-swatch');
    els.sheetTitle = byId('sheet-title');
    els.sheetSub = byId('sheet-sub');
    els.sheetNote = byId('sheet-note');
    els.sheetBody = byId('sheet-body');
    els.sheetDone = byId('sheet-done');
    slides = [slideParts(byId('slide-a')), slideParts(byId('slide-b'))];
  }

  function init() {
    findElements();
    els.panelClose.insertBefore(makeIcon('photos'), els.panelClose.firstChild);
    els.panelSettings.appendChild(makeIcon('sliders'));
    // iOS only sends click events for elements with a click handler, so the
    // handler is set as a property rather than with addEventListener.
    els.frame.onclick = function () {
      if (!panelOpen && Date.now() - swipedAt > 500) {
        openPanel();
      }
    };
    els.frame.ontouchstart = onFrameTouchStart;
    els.frame.ontouchend = onFrameTouchEnd;
    els.frame.ontouchcancel = function () {
      swipeStart = null;
    };
    // Stops Safari from dragging the whole page around under the finger.
    els.frame.ontouchmove = function (event) {
      event.preventDefault();
    };
    // The arrow keys do the same as a swipe in a desktop browser.
    document.onkeydown = function (event) {
      if (panelOpen) {
        return;
      }
      if (event.keyCode === 39) {
        showNextSlide(true);
      } else if (event.keyCode === 37) {
        showPreviousSlide();
      }
    };
    els.panelClose.onclick = closePanel;
    els.panelSettings.onclick = openSettings;
    els.settingsDone.onclick = closeSettings;
    els.sheetDone.onclick = closeColorSheet;
    // A tap beside the sheet closes it.
    els.sheet.onclick = function (event) {
      if (event.target === els.sheet) {
        closeColorSheet();
      }
    };
    // These touch handlers also let iOS show the :active press states.
    els.panel.ontouchstart = els.settings.ontouchstart = els.sheet.ontouchstart = function () {
      if (panelOpen) {
        touchPanel();
      }
    };
    window.onresize = refitVisibleSlide;
    showMessage('Loading photos...');

    loadConfig(function () {
      applyFrameSettings();
      renderClock();
      setInterval(renderClock, 1000);
      setInterval(watchdog, 30 * 1000);
      setInterval(checkServer, 60 * 1000);
      showNextSlide(false);
    });
  }

  init();
}());
