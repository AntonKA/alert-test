// Shared browser code: config, API calls, Realtime socket. No libraries.
(function () {
  'use strict';
  const CFG = window.ALERT_TEST || {};
  const REQUIRED_KEYS = ['functionUrl', 'realtimeUrl', 'publishableKey', 'vapidPublicKey'];
  const PLACEHOLDER_PREFIX = '__';
  const SESSION_RE = /^[a-z0-9]{6,12}$/;
  const HEARTBEAT_MS = 25000;
  const RETRY_WAITS_MS = [1000, 2000, 5000, 10000];
  const KEY_BYTES = 16;
  const KEY_STORAGE = 'alert-test-device-key';
  const USER_AGENT_MAX = 300;
  const JOIN_REF = '1';
  let memoryKey = null;

  function setStatus(message, isError) {
    const box = document.getElementById('status');
    if (!box) return;
    box.textContent = message;
    box.className = isError ? 'error' : '';
  }

  function configProblem() {
    for (const key of REQUIRED_KEYS) {
      const value = CFG[key];
      if (!value || String(value).startsWith(PLACEHOLDER_PREFIX)) {
        return 'Not configured: ' + key + ' in config.js';
      }
    }
    return null;
  }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    Object.assign(node, props || {});
    for (const child of children || []) {
      node.append(child);
    }
    return node;
  }

  function randomHex(bytes) {
    const data = crypto.getRandomValues(new Uint8Array(bytes));
    return Array.from(data, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function deviceKey() {
    try {
      const saved = localStorage.getItem(KEY_STORAGE);
      if (saved) return saved;
    } catch (e) {
      // Storage is blocked: fall through to a value kept for this page only.
    }
    if (!memoryKey) memoryKey = randomHex(KEY_BYTES);
    try {
      localStorage.setItem(KEY_STORAGE, memoryKey);
    } catch (e) {
      // Storage is blocked: the page-only value is used.
    }
    return memoryKey;
  }

  async function api(path, options) {
    const opts = options || {};
    const url = new URL(CFG.functionUrl.replace(/\/+$/, '') + '/' + path);
    for (const [k, v] of Object.entries(opts.query || {})) {
      url.searchParams.set(k, v);
    }
    const headers = { apikey: CFG.publishableKey, Authorization: 'Bearer ' + CFG.publishableKey };
    const init = { method: opts.body ? 'POST' : 'GET', headers };
    if (opts.body) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw new Error('Could not reach the test server (' + e.message + ')');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Server answered ' + res.status);
    return data;
  }

  function openRealtime(session, handlers) {
    const topic = 'realtime:alerttest:' + session;
    let ws = null;
    let attempt = 0;
    let closed = false;
    let heartbeat = null;
    let retry = null;
    let beatRef = 1;

    function send(message) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    }

    function join() {
      const config = { broadcast: { ack: false, self: false }, presence: { key: '' }, postgres_changes: [], private: false };
      send({ topic, event: 'phx_join', payload: { config }, ref: JOIN_REF, join_ref: JOIN_REF });
    }

    function onMessage(raw) {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        handlers.onError('Unreadable live message: ' + e.message);
        return;
      }
      if (msg.event === 'phx_reply' && msg.ref === JOIN_REF) {
        const ok = msg.payload && msg.payload.status === 'ok';
        if (ok) attempt = 0;
        handlers.onState(ok, ok ? 'Joined channel' : 'Channel join refused');
        if (ok && handlers.onJoined) handlers.onJoined();
      } else if ((msg.event === 'phx_close' || msg.event === 'phx_error') && msg.topic === topic) {
        handlers.onState(false, 'Channel ' + msg.event.slice(4) + ', reconnecting');
        if (ws) ws.close();
      } else if (msg.event === 'broadcast' && msg.payload && msg.payload.event === 'ready') {
        handlers.onAlert(Number(msg.payload.payload && msg.payload.payload.alert_id));
      }
    }

    function scheduleRetry() {
      if (closed) return;
      const wait = RETRY_WAITS_MS[Math.min(attempt, RETRY_WAITS_MS.length - 1)];
      attempt += 1;
      retry = setTimeout(connect, wait);
    }

    function connect() {
      const url = CFG.realtimeUrl + '?apikey=' + encodeURIComponent(CFG.publishableKey) + '&vsn=1.0.0';
      ws = new WebSocket(url);
      ws.onopen = () => {
        join();
        heartbeat = setInterval(() => {
          beatRef += 1;
          send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(beatRef) });
        }, HEARTBEAT_MS);
      };
      ws.onmessage = (ev) => onMessage(ev.data);
      ws.onerror = () => handlers.onState(false, 'Connection error');
      ws.onclose = () => {
        clearInterval(heartbeat);
        handlers.onState(false, closed ? 'Closed' : 'Disconnected, retrying');
        scheduleRetry();
      };
    }

    connect();
    return {
      close() {
        closed = true;
        clearTimeout(retry);
        clearInterval(heartbeat);
        if (ws) ws.close();
      },
    };
  }

  window.AlertApp = {
    CFG, SESSION_RE, USER_AGENT_MAX, setStatus, configProblem, el, deviceKey, api, openRealtime,
  };
})();
