const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'frontend/coldchain-monitor.js'), 'utf8');
const copy = (value) => JSON.parse(JSON.stringify(value));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await delay(5);
  }
  assert.fail('ColdChain monitor did not reach the expected state');
}

function makeState({ hot = false, cold = false } = {}) {
  const clinics = Array.from({ length: 20 }, (_, index) => ({
    id: `CL-${String(index + 1).padStart(2, '0')}`,
    name: `Clinic ${index + 1}`,
    feeder_id: index % 6 + 1,
    power_on: true,
    temperature_c: index === 0 && hot ? 6.4 : index === 1 && cold ? 1.4 : 4.4,
    temperature_alarm: false,
    too_cold: index === 1 && cold,
    risk_level: hot || cold ? 'Critical' : 'Safe',
    status: hot || cold ? 'Cold-chain violation' : 'Online',
    data_quality: 'ok',
    source: 'simulation',
    observed_at: '2025-01-01T08:00:00Z'
  }));
  if (hot) clinics[0].temperature_alarm = true;
  return {
    timestamp: '2025-01-01T08:00:00Z',
    telemetry_mode: 'simulation',
    telemetry_status: 'Telemetry current',
    summary: { total_clinics: 20, powered_clinics: 20, total_feeders: 6, active_feeders: 6, system_health: hot || cold ? 'Critical' : 'Healthy' },
    feeders: Array.from({ length: 6 }, (_, index) => ({ id: index + 1, name: `Feeder ${index + 1}`, online: true, data_quality: 'ok' })),
    clinics
  };
}

function setup({ initial, audio = false } = {}) {
  const dom = new JSDOM(html, { url: 'http://localhost:8000', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  let current = copy(initial || makeState());
  const calls = [];
  let beepStarts = 0;

  if (audio) {
    window.AudioContext = class {
      constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
      resume() { return Promise.resolve(); }
      createOscillator() {
        return {
          type: 'sine',
          frequency: { setValueAtTime() {} },
          connect() {},
          start() { beepStarts += 1; },
          stop() {}
        };
      }
      createGain() {
        return {
          gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
          connect() {}
        };
      }
    };
  }

  window.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/state') return { ok: true, status: 200, json: async () => copy(current) };
    if (url === '/api/simulate') {
      const payload = JSON.parse(options.body);
      if (payload.action === 'trip_feeder') {
        current.feeders[payload.feeder_id - 1].online = false;
        current.clinics.filter((clinic) => clinic.feeder_id === payload.feeder_id).forEach((clinic) => { clinic.power_on = false; });
      }
      return { ok: true, status: 200, json: async () => copy(current) };
    }
    throw new Error(`Unexpected API call: ${url}`);
  };

  vm.runInContext(source, dom.getInternalVMContext());
  return {
    dom,
    window,
    calls,
    setState(next) { current = copy(next); },
    getBeepStarts() { return beepStarts; },
    $: (id) => window.document.getElementById(id)
  };
}

test('ColdChain monitor renders all clinics and posts the feeder-3 control', async (t) => {
  const ui = setup();
  t.after(() => ui.window.ColdChainMonitor.destroy());
  await until(() => ui.$('cc-clinic-grid').querySelectorAll('.cc-clinic-card').length === 20);
  assert.equal(ui.$('cc-clinics-total').textContent, '20');
  assert.match(ui.$('cc-clinic-grid').firstElementChild.textContent, /4\.4°C/);
  assert.equal(ui.$('cc-trip-feeder').disabled, false);

  ui.$('cc-trip-feeder').click();
  await until(() => ui.calls.some((call) => call.url === '/api/simulate'));
  await until(() => /applied/.test(ui.$('cc-action-status').textContent));
  const mutation = ui.calls.find((call) => call.url === '/api/simulate');
  assert.deepEqual(JSON.parse(mutation.options.body), { action: 'trip_feeder', feeder_id: 3 });
  assert.match(ui.$('cc-clinic-grid').textContent, /Offline/);

  ui.$('cc-advance-1').click();
  await until(() => ui.calls.filter((call) => call.url === '/api/simulate').length === 2);
  assert.deepEqual(JSON.parse(ui.calls.filter((call) => call.url === '/api/simulate')[1].options.body), { action: 'advance', hours: 1 });
  await until(() => /Advance 1 hour applied/.test(ui.$('cc-action-status').textContent));
  ui.$('cc-advance-6').click();
  await until(() => ui.calls.filter((call) => call.url === '/api/simulate').length === 3);
  assert.deepEqual(JSON.parse(ui.calls.filter((call) => call.url === '/api/simulate')[2].options.body), { action: 'advance', hours: 6 });
  await until(() => /Advance 6 hours applied/.test(ui.$('cc-action-status').textContent));
  ui.$('cc-reset').click();
  await until(() => ui.calls.filter((call) => call.url === '/api/simulate').length === 4);
  assert.deepEqual(JSON.parse(ui.calls.filter((call) => call.url === '/api/simulate')[3].options.body), { action: 'reset' });
  await until(() => /Reset simulation applied/.test(ui.$('cc-action-status').textContent));
});

test('alarm sound beeps once on a new threshold crossing and visual alarm persists', async (t) => {
  const ui = setup({ audio: true });
  t.after(() => ui.window.ColdChainMonitor.destroy());
  await until(() => ui.$('cc-clinic-grid').querySelectorAll('.cc-clinic-card').length === 20);
  ui.$('cc-sound-toggle').click();
  await until(() => ui.window.ColdChainMonitor.getSnapshot().soundUnlocked === true);

  ui.setState(makeState({ hot: true }));
  await ui.window.ColdChainMonitor.refresh();
  assert.equal(ui.getBeepStarts(), 2, 'one short double beep should use two oscillator starts');
  assert.equal(ui.$('cc-alarm-banner').hidden, false);
  assert.match(ui.$('cc-alarm-title').textContent, />6°C/);

  await ui.window.ColdChainMonitor.refresh();
  assert.equal(ui.getBeepStarts(), 2, 'the same alarm must not beep on every poll');

  ui.setState(makeState());
  await ui.window.ColdChainMonitor.refresh();
  ui.setState(makeState({ hot: true }));
  await ui.window.ColdChainMonitor.refresh();
  assert.equal(ui.getBeepStarts(), 4, 'a later threshold crossing should beep again');
});

test('unauthorized refresh keeps the last known clinic cards', async (t) => {
  const ui = setup();
  t.after(() => ui.window.ColdChainMonitor.destroy());
  await until(() => ui.$('cc-clinic-grid').querySelectorAll('.cc-clinic-card').length === 20);
  const originalFetch = ui.window.fetch;
  ui.window.fetch = async (url, options) => {
    if (url === '/api/state') return { ok: false, status: 401, json: async () => ({ detail: 'Bearer token required' }) };
    return originalFetch(url, options);
  };
  await ui.window.ColdChainMonitor.refresh();
  assert.equal(ui.$('cc-clinic-grid').querySelectorAll('.cc-clinic-card').length, 20);
  assert.equal(ui.$('cc-connection-label').textContent, 'Authorization required');
});
