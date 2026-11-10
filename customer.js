// Customer page: Start button, status rows, ring, wake lock, live and poll routes.
(function () {
  'use strict';
  const App = window.AlertApp;
  const $ = (id) => document.getElementById(id);
  const RING_MAX_MS = 30000;
  const TEST_RING_MS = 2500;
  const POLL_MS = 10000;
  const PLAY_WAIT_MS = 1500;
  const VIBRATE = [400, 200, 400, 200, 400];
  const SAMPLE_RATE = 22050;
  const WAV_SECONDS = 0.6;
  const TONE_HZ = [880, 660];
  const AMPLITUDE = 0.6 * 32767;
  const WAV_HEADER_BYTES = 44;
  const BYTES_PER_SAMPLE = 2;
  const CONFIG_CACHE = 'alert-test-config';
  const CONFIG_KEY = 'sw-config.json';
  const ROW_NAMES = {
    live: 'Live connection',
    notif: 'Notifications allowed',
    push: 'Push registered',
    awake: 'Screen kept awake',
    home: 'Opened from Home Screen',
  };
  const state = {
    session: null, label: null, started: false, audio: null, lock: null,
    lastAlertId: 0, ringTimer: null, connected: false, pollTimer: null, problems: [],
  };

  function setRow(key, on, reason) {
    const row = $('row-' + key);
    row.className = on ? 'on' : 'off';
    row.querySelector('.state').textContent = on ? 'on' : 'off';
    row.querySelector('.reason').textContent = reason;
  }

  function buildRows() {
    for (const [key, name] of Object.entries(ROW_NAMES)) {
      const row = App.el('li', { id: 'row-' + key, className: 'off' }, [
        App.el('span', { className: 'name', textContent: name }),
        App.el('span', { className: 'state', textContent: 'off' }),
        App.el('span', { className: 'reason', textContent: 'Not started' }),
      ]);
      $('rows').append(row);
    }
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  }

  function guessLabel() {
    const ua = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(ua)) return isStandalone() ? 'iphone_home_screen' : 'iphone_browser';
    if (/Android/.test(ua)) return 'android';
    return null;
  }

  function selectLabel(label) {
    state.label = label;
    for (const b of $('labels').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.label === label));
    }
  }

  // ---- ring ----
  function writeText(view, offset, text) {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  }

  function buildWav() {
    const samples = Math.floor(SAMPLE_RATE * WAV_SECONDS);
    const dataBytes = samples * BYTES_PER_SAMPLE;
    const view = new DataView(new ArrayBuffer(WAV_HEADER_BYTES + dataBytes));
    writeText(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeText(view, 8, 'WAVEfmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, SAMPLE_RATE, true);
    view.setUint32(28, SAMPLE_RATE * BYTES_PER_SAMPLE, true);
    view.setUint16(32, BYTES_PER_SAMPLE, true);
    view.setUint16(34, 16, true); // bits per sample
    writeText(view, 36, 'data');
    view.setUint32(40, dataBytes, true);
    for (let i = 0; i < samples; i += 1) {
      const hz = TONE_HZ[i < samples / 2 ? 0 : 1];
      view.setInt16(WAV_HEADER_BYTES + i * BYTES_PER_SAMPLE, Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * AMPLITUDE, true);
    }
    return new Blob([view.buffer], { type: 'audio/wav' });
  }

  function getAudio() {
    if (!state.audio) {
      const audio = new Audio(URL.createObjectURL(buildWav()));
      audio.loop = true;
      audio.preload = 'auto';
      state.audio = audio;
    }
    return state.audio;
  }

  function unlockAudio() {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    const audio = getAudio();
    return audio.play().then(() => {
      audio.pause();
      audio.currentTime = 0;
    });
  }

  async function startRing() {
    try {
      await getAudio().play();
      return true;
    } catch (e) {
      App.setStatus('The sound was blocked: ' + e.message, true);
      return false;
    }
  }

  function stopRing() {
    clearTimeout(state.ringTimer);
    if (state.audio) {
      state.audio.pause();
      state.audio.currentTime = 0;
    }
    if (navigator.vibrate) navigator.vibrate(0);
  }

  // Do not let a stuck play() hold back the arrival report.
  function startRingTimed() {
    const timeout = new Promise((resolve) => setTimeout(() => resolve(false), PLAY_WAIT_MS));
    return Promise.race([startRing(), timeout]);
  }

  async function testRing() {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    const ok = await startRing();
    if (ok) state.ringTimer = setTimeout(stopRing, TEST_RING_MS);
  }

  // ---- alerts ----
  async function sendArrival(alertId, soundPlayed, route) {
    try {
      await App.api('arrival', { body: {
        session: state.session,
        device_key: App.deviceKey(),
        alert_id: alertId,
        route,
        page_visible: document.visibilityState === 'visible',
        sound_played: soundPlayed,
        wake_lock_held: Boolean(state.lock),
      } });
    } catch (e) {
      App.setStatus('Could not report the alert: ' + e.message, true);
    }
  }

  // route is 'page' for a live message and 'page_catchup' when found by polling or on return.
  async function onAlert(alertId, route) {
    if (!alertId || alertId <= state.lastAlertId) return;
    state.lastAlertId = alertId;
    $('alert-number').textContent = 'Alert ' + alertId;
    $('ready').hidden = false;
    clearTimeout(state.ringTimer);
    const sound = await startRingTimed();
    state.ringTimer = setTimeout(stopRing, RING_MAX_MS);
    if (navigator.vibrate) navigator.vibrate(VIBRATE);
    await sendArrival(alertId, sound, route);
  }

  async function latestAlertId() {
    const log = await App.api('log', { query: { session: state.session } });
    return log.alerts.length ? log.alerts[0].id : 0;
  }

  async function catchUp() {
    try {
      await onAlert(await latestAlertId(), 'page_catchup');
    } catch (e) {
      App.setStatus('Could not check for alerts: ' + e.message, true);
    }
  }

  function updatePolling() {
    const needed = state.started && !state.connected;
    if (needed && !state.pollTimer) state.pollTimer = setInterval(catchUp, POLL_MS);
    if (!needed && state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  // ---- wake lock ----
  async function requestWakeLock() {
    if (!navigator.wakeLock) {
      setRow('awake', false, 'Screen lock is not supported here');
      $('banner').hidden = false;
      return;
    }
    try {
      state.lock = await navigator.wakeLock.request('screen');
      state.lock.addEventListener('release', () => {
        state.lock = null;
        setRow('awake', false, 'The screen lock was released');
        $('banner').hidden = false;
      });
      setRow('awake', true, 'Holding the screen lock');
      $('banner').hidden = true;
    } catch (e) {
      state.lock = null;
      setRow('awake', false, e.message);
      $('banner').hidden = false;
      throw e;
    }
  }

  // ---- Start ----
  async function step(name, fn) {
    try {
      return await fn();
    } catch (e) {
      state.problems.push(name + ': ' + e.message);
      App.setStatus(state.problems.join('  |  '), true);
      return null;
    }
  }

  async function askPermission() {
    if (!('Notification' in window)) {
      setRow('notif', false, 'Notifications are not available here');
      return 'unsupported';
    }
    const permission = await Notification.requestPermission();
    setRow('notif', permission === 'granted', 'Permission: ' + permission);
    return permission;
  }

  async function registerWorker() {
    if (!('serviceWorker' in navigator)) throw new Error('Service workers are not available here');
    await navigator.serviceWorker.register('sw.js');
    return navigator.serviceWorker.ready;
  }

  function keyBytes(base64url) {
    const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  }

  async function subscribePush(reg, permission) {
    if (!reg || !('PushManager' in window)) {
      setRow('push', false, 'Push is not available here');
      return null;
    }
    if (permission !== 'granted') {
      setRow('push', false, 'Needs notification permission first');
      return null;
    }
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(App.CFG.vapidPublicKey),
    }));
    setRow('push', true, 'Subscribed');
    return sub;
  }

  async function saveWorkerSettings() {
    const settings = {
      session: state.session, deviceKey: App.deviceKey(),
      functionUrl: App.CFG.functionUrl, publishableKey: App.CFG.publishableKey,
    };
    const cache = await caches.open(CONFIG_CACHE);
    await cache.put(CONFIG_KEY, new Response(JSON.stringify(settings), { headers: { 'Content-Type': 'application/json' } }));
  }

  function startLive() {
    App.openRealtime(state.session, {
      onAlert: (id) => onAlert(id, 'page'),
      onJoined: catchUp,
      onError: (m) => App.setStatus(m, true),
      onState: (ok, reason) => {
        state.connected = ok;
        setRow('live', ok, reason);
        updatePolling();
      },
    });
  }

  async function registerDevice(sub) {
    await App.api('device', { body: {
      session: state.session,
      device_key: App.deviceKey(),
      label: state.label,
      subscription: sub ? sub.toJSON() : null,
      user_agent: navigator.userAgent.slice(0, App.USER_AGENT_MAX),
    } });
  }

  async function start() {
    const problem = App.configProblem() || (state.label ? null : 'Choose which phone this is first');
    if (problem) return App.setStatus(problem, true);
    $('start').disabled = true;
    state.problems = [];
    const unlocked = step('Sound', unlockAudio); // must begin inside the tap
    const permission = await step('Notifications', askPermission);
    const reg = await step('Service worker', registerWorker);
    await step('Worker settings', saveWorkerSettings);
    const sub = await step('Push', () => subscribePush(reg, permission));
    await step('Screen lock', requestWakeLock);
    await step('Alert check', async () => { state.lastAlertId = await latestAlertId(); });
    await step('Register device', () => registerDevice(sub));
    state.started = true;
    await step('Live connection', async () => startLive());
    await unlocked;
    if (!state.problems.length) App.setStatus('Ready. Leave this page as the test asks.');
  }

  function init() {
    buildRows();
    setRow('home', isStandalone(), isStandalone() ? 'Running from the Home Screen' : 'Running in a browser tab');
    $('audio-session-line').textContent = 'Silent-mode sound setting: ' + (navigator.audioSession ? 'available' : 'not available on this browser');
    const code = new URLSearchParams(location.search).get('s');
    if (!code || !App.SESSION_RE.test(code)) {
      $('session-form').hidden = false;
      if (code) App.setStatus('That session code is not valid.', true);
      return;
    }
    state.session = code;
    $('main').hidden = false;
    $('session-line').textContent = 'Session: ' + code;
    selectLabel(guessLabel());
    const problem = App.configProblem();
    if (problem) App.setStatus(problem, true);
  }

  $('session-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const code = $('session-input').value.trim().toLowerCase();
    if (!App.SESSION_RE.test(code)) return App.setStatus('Use 6 to 12 letters or digits.', true);
    location.href = 'index.html?s=' + code;
  });
  $('labels').addEventListener('click', (ev) => {
    if (ev.target.dataset.label) selectLabel(ev.target.dataset.label);
  });
  $('start').addEventListener('click', start);
  $('test-ring').addEventListener('click', testRing);
  $('stop').addEventListener('click', () => {
    stopRing();
    $('ready').hidden = true;
  });
  $('banner').addEventListener('click', () => step('Screen lock', requestWakeLock));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.started) return;
    if (!state.lock) step('Screen lock', requestWakeLock);
    catchUp();
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (ev) => {
      if (ev.data && ev.data.type === 'sw-error') App.setStatus(ev.data.message, true);
    });
  }
  init();
})();
