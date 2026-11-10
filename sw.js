'use strict';
// Service worker: shows a notification on push and reports the arrival.
const CONFIG_CACHE = 'alert-test-config';
const CONFIG_KEY = 'sw-config.json';
const NOTIFICATION_TAG = 'alert-test';
const VIBRATE = [400, 200, 400, 200, 400];

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

async function loadConfig() {
  const cache = await caches.open(CONFIG_CACHE);
  const saved = await cache.match(CONFIG_KEY);
  if (!saved) throw new Error('No saved settings. Open the page and tap Start.');
  return saved.json();
}

async function anyVisibleClient() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return windows.some((w) => w.visibilityState === 'visible');
}

async function tellClients(message) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const w of windows) w.postMessage({ type: 'sw-error', message });
}

async function reportArrival(cfg, route) {
  const res = await fetch(cfg.functionUrl.replace(/\/+$/, '') + '/arrival', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: cfg.publishableKey,
      Authorization: 'Bearer ' + cfg.publishableKey,
    },
    body: JSON.stringify({
      session: cfg.session,
      device_key: cfg.deviceKey,
      alert_id: null,
      route,
      page_visible: await anyVisibleClient(),
      sound_played: false,
      wake_lock_held: false,
    }),
  });
  if (!res.ok) throw new Error('Arrival report refused: ' + res.status);
}

async function safeReport(route) {
  try {
    await reportArrival(await loadConfig(), route);
  } catch (e) {
    console.error('Alert test worker:', e);
    await tellClients('Worker could not report ' + route + ': ' + e.message);
  }
}

function showAlert() {
  return self.registration.showNotification('Alert test: READY', {
    body: 'Tap to open',
    tag: NOTIFICATION_TAG,
    renotify: true,
    requireInteraction: true,
    vibrate: VIBRATE,
  });
}

self.addEventListener('push', (event) => {
  event.waitUntil(Promise.all([showAlert(), safeReport('push')]));
});

async function focusOrOpen() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (windows.length > 0) return windows[0].focus();
  let target = 'index.html';
  try {
    target += '?s=' + encodeURIComponent((await loadConfig()).session);
  } catch (e) {
    console.error('Alert test worker:', e);
  }
  return self.clients.openWindow(new URL(target, self.registration.scope).href);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(Promise.all([safeReport('push_click'), focusOrOpen()]));
});
