// Staff page: session link, devices, Ready button, results grid, log, CSV export.
(function () {
  'use strict';
  const App = window.AlertApp;
  const $ = (id) => document.getElementById(id);
  const SESSION_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no i, l, o, 0, 1
  const SESSION_LENGTH = 8;
  const COUNTDOWN_S = 30;
  const LATE_AFTER_S = 30;
  const IDLE_REFRESH_MS = 3000;
  const ACTIVE_REFRESH_MS = 2000;
  const TICK_MS = 1000;
  const REVOKE_DELAY_MS = 1000;
  const ROUTES = ['page', 'page_catchup', 'push', 'push_click'];
  const COUNTED_ROUTES = ['page', 'push'];
  const SITUATIONS = [
    { id: 'open_screen_on', name: 'Page open, screen on', hint: 'Keep the customer page open and the screen on.' },
    { id: 'screen_locked', name: 'Screen locked', hint: 'Lock the phone and wait 10 seconds.' },
    { id: 'other_app', name: 'Another app in front', hint: 'Open another app, such as Notes, and wait 10 seconds.' },
    { id: 'silent_mode', name: 'Silent mode', hint: 'Turn on the silent switch or silent mode, keep the screen on, then tap Ready.' },
    { id: 'low_power', name: 'Low power mode', hint: 'Turn on Low Power Mode or Battery Saver, keep the page open, do not touch the phone for 40 seconds, then tap Ready.' },
  ];
  const LABELS = [
    { id: 'iphone_browser', name: 'iPhone, in the browser' },
    { id: 'iphone_home_screen', name: 'iPhone, Home Screen' },
    { id: 'android', name: 'Android' },
  ];
  const CSV_COLUMNS = ['alert_id', 'situation', 'sent_at', 'device', 'route', 'seconds', 'page_visible', 'sound_played', 'wake_lock_held', 'heard', 'felt'];
  const state = { session: null, situation: SITUATIONS[0].id, log: { alerts: [], devices: [] }, watchUntil: 0, timer: null, ticks: {}, readyMessage: '' };

  function newSession() {
    const bytes = crypto.getRandomValues(new Uint8Array(SESSION_LENGTH));
    return Array.from(bytes, (b) => SESSION_ALPHABET[b % SESSION_ALPHABET.length]).join('');
  }

  function customerLink() {
    const dir = location.pathname.replace(/[^/]*$/, '');
    return location.origin + dir + 'index.html?s=' + state.session;
  }

  function latestDevice(label) {
    const matches = state.log.devices.filter((d) => d.label === label);
    return matches.length ? matches[matches.length - 1] : null;
  }

  // Ticks the tester made: kept locally so /log cannot overwrite them while a save is in flight.
  function tickKey(alertId, deviceId) {
    return alertId + ':' + deviceId;
  }

  function effectiveNote(alert, deviceId) {
    const local = state.ticks[tickKey(alert.id, deviceId)];
    return local || alert.notes.find((n) => n.device_id === deviceId) || {};
  }

  function savesInFlight() {
    return Object.values(state.ticks).some((t) => t.saving > 0);
  }

  function cellInfo(situationId, labelId) {
    const alert = state.log.alerts.find((a) => a.situation === situationId);
    const device = latestDevice(labelId);
    if (!alert || !device) return { cls: 'grey', alert, device, text: alert ? 'No phone' : 'Not tested' };
    const mine = alert.arrivals.filter((a) => a.device_id === device.id);
    const times = mine.filter((a) => COUNTED_ROUTES.includes(a.route)).map((a) => a.seconds);
    const age = (Date.now() - Date.parse(alert.sent_at)) / 1000;
    let cls = 'grey';
    if (times.length) cls = Math.min(...times) <= LATE_AFTER_S ? 'green' : 'amber';
    else if (age > LATE_AFTER_S) cls = 'red';
    return { cls, alert, device, mine };
  }

  function routeText(mine, route) {
    const hit = mine.find((a) => a.route === route);
    return route + ': ' + (hit ? hit.seconds + ' s' : 'no');
  }

  function catchupText(mine) {
    const hit = mine.find((a) => a.route === 'page_catchup');
    return hit ? 'seen on return after ' + hit.seconds + ' s' : null;
  }

  function tickBox(info, field, text) {
    const note = effectiveNote(info.alert, info.device.id);
    const box = App.el('input', { type: 'checkbox', checked: Boolean(note[field]) });
    box.addEventListener('change', () => saveNote(info, field, box.checked));
    return App.el('label', {}, [box, ' ' + text]);
  }

  async function saveNote(info, field, value) {
    const key = tickKey(info.alert.id, info.device.id);
    const current = effectiveNote(info.alert, info.device.id);
    const entry = state.ticks[key] || { heard: Boolean(current.heard), felt: Boolean(current.felt), saving: 0 };
    state.ticks[key] = entry;
    entry[field] = value;
    entry.saving += 1;
    const body = { session: state.session, alert_id: info.alert.id, device_id: info.device.id, heard: entry.heard, felt: entry.felt };
    try {
      await App.api('note', { body });
    } catch (e) {
      delete state.ticks[key];
      App.setStatus('Could not save the tick: ' + e.message, true);
    } finally {
      entry.saving -= 1;
    }
  }

  function buildCell(situationId, labelId) {
    const info = cellInfo(situationId, labelId);
    const td = App.el('td', { className: info.cls });
    if (!info.mine) {
      td.textContent = info.text;
      return td;
    }
    td.append(App.el('div', { textContent: routeText(info.mine, 'page') }));
    td.append(App.el('div', { textContent: routeText(info.mine, 'push') }));
    const late = catchupText(info.mine);
    if (late) td.append(App.el('div', { textContent: late }));
    td.append(tickBox(info, 'heard', 'heard it'), tickBox(info, 'felt', 'felt it'));
    return td;
  }

  function renderGrid() {
    if (savesInFlight()) return; // do not rebuild a cell while its tick is being saved
    const head = App.el('tr', {}, [App.el('th', { textContent: 'Situation' }), ...LABELS.map((l) => App.el('th', { textContent: l.name }))]);
    const rows = SITUATIONS.map((s) => App.el('tr', {}, [App.el('th', { textContent: s.name }), ...LABELS.map((l) => buildCell(s.id, l.id))]));
    $('grid').replaceChildren(head, ...rows);
  }

  function renderDevices() {
    const items = state.log.devices.map((d) => {
      const name = (LABELS.find((l) => l.id === d.label) || {}).name || d.label;
      return App.el('li', { textContent: name + ': ' + (d.has_subscription ? 'push registered' : 'no push') });
    });
    $('devices').replaceChildren(...(items.length ? items : [App.el('li', { textContent: 'No phone has joined yet.' })]));
  }

  function flatRows(full) {
    const rows = [];
    for (const a of state.log.alerts) {
      const base = { alert_id: a.id, situation: a.situation, sent_at: a.sent_at };
      for (const d of state.log.devices) {
        const note = effectiveNote(a, d.id);
        for (const route of ROUTES) {
          const r = a.arrivals.find((x) => x.device_id === d.id && x.route === route);
          if (!full && !r) continue;
          rows.push({ ...base, device: d.label, route, seconds: r && r.seconds, page_visible: r && r.page_visible, sound_played: r && r.sound_played, wake_lock_held: r && r.wake_lock_held, heard: note.heard, felt: note.felt });
        }
      }
      if (!full && !a.arrivals.length) rows.push(base);
    }
    return rows;
  }

  function renderLog() {
    const head = App.el('tr', {}, CSV_COLUMNS.map((c) => App.el('th', { textContent: c })));
    const rows = flatRows(false).map((r) => App.el('tr', {}, CSV_COLUMNS.map((c) => App.el('td', { textContent: r[c] === undefined || r[c] === null ? '' : String(r[c]) }))));
    $('log').replaceChildren(head, ...rows);
  }

  function csvField(value) {
    const text = value === undefined || value === null ? '' : String(value);
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function exportCsv() {
    const lines = [CSV_COLUMNS.join(',')];
    for (const r of flatRows(true)) lines.push(CSV_COLUMNS.map((c) => csvField(r[c])).join(','));
    const url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }));
    const link = App.el('a', { href: url, download: 'alert-test-' + state.session + '.csv' });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }

  function schedule() {
    clearTimeout(state.timer);
    const active = Date.now() < state.watchUntil;
    state.timer = setTimeout(refresh, active ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS);
  }

  async function refresh() {
    try {
      state.log = await App.api('log', { query: { session: state.session } });
      renderDevices();
      renderGrid();
      renderLog();
      App.setStatus((state.readyMessage ? state.readyMessage + '  |  ' : '') + 'Updated ' + new Date().toLocaleTimeString());
    } catch (e) {
      App.setStatus('Could not load results: ' + e.message, true);
    }
    schedule();
  }

  function runCountdown() {
    state.watchUntil = Date.now() + COUNTDOWN_S * TICK_MS;
    $('ready').disabled = true;
    const tick = setInterval(() => {
      const left = Math.ceil((state.watchUntil - Date.now()) / TICK_MS);
      $('countdown').textContent = left > 0 ? 'Watching for arrivals: ' + left + ' s' : 'Done. Tick what you heard and felt.';
      if (left <= 0) {
        clearInterval(tick);
        $('ready').disabled = false;
      }
    }, TICK_MS);
  }

  function pushSummary(push) {
    if (!push.length) return 'Push: no phone has push registered';
    const isOk = (p) => typeof p.status === 'number' && p.status >= 200 && p.status < 300;
    const sent = push.filter(isOk).map((p) => p.status);
    const refused = push.filter((p) => !isOk(p)).map((p) => p.status);
    const parts = [];
    if (sent.length) parts.push(sent.length + ' sent (' + sent.join(', ') + ')');
    if (refused.length) parts.push(refused.length + ' refused (' + refused.join(', ') + ')');
    return 'Push: ' + parts.join(', ');
  }

  async function sendReady() {
    $('ready').disabled = true;
    try {
      const result = await App.api('ready', { body: { session: state.session, situation: state.situation } });
      state.readyMessage = 'Alert ' + result.alert_id + ' sent. ' + pushSummary(result.push);
      runCountdown();
      clearTimeout(state.timer);
      refresh();
    } catch (e) {
      App.setStatus('Ready failed: ' + e.message, true);
      $('ready').disabled = false;
    }
  }

  function buildSituations() {
    const nodes = SITUATIONS.map((s, i) => {
      const radio = App.el('input', { type: 'radio', name: 'situation', value: s.id, checked: i === 0 });
      radio.addEventListener('change', () => { state.situation = s.id; });
      return App.el('div', {}, [
        App.el('label', { className: 'situation' }, [radio, ' ' + s.name]),
        App.el('div', { className: 'hint', textContent: s.hint }),
      ]);
    });
    $('situations').replaceChildren(...nodes);
  }

  function init() {
    const param = new URLSearchParams(location.search).get('s');
    state.session = param && App.SESSION_RE.test(param) ? param : newSession();
    if (param !== state.session) history.replaceState(null, '', '?s=' + state.session);
    $('link').textContent = customerLink();
    buildSituations();
    const problem = App.configProblem();
    if (problem) return App.setStatus(problem, true);
    refresh();
  }

  $('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(customerLink());
      App.setStatus('Link copied.');
    } catch (e) {
      App.setStatus('Could not copy: ' + e.message, true);
    }
  });
  $('ready').addEventListener('click', sendReady);
  $('export').addEventListener('click', exportCsv);
  init();
})();
