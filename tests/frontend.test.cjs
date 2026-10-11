// DOM unit tests, not a substitute for real-browser layout/animation testing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
const code = fs.readFileSync(path.join(root, 'frontend/app.js'), 'utf8');
const copy = (value) => JSON.parse(JSON.stringify(value));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await delay(10); }
  assert.fail('UI did not reach the expected state');
}

function setup({ required = false, role = 'admin', stale = false, failMutation = false } = {}) {
  const dom = new JSDOM(html, { url: 'http://localhost:8000', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {}, set: () => true });
  const errors = [];
  window.addEventListener('error', (event) => errors.push(event.error));
  const user = { username: 'test-user', role, user_id: 1 };
  const live = {
    timestamp: '2025-01-01T08:00:00Z', horizon_hours: 6, model_ready: true,
    telemetry_status: stale ? 'Telemetry stale' : 'Telemetry current', stale_sensor_count: stale ? 1 : 0,
    telemetry_mode: 'simulation',
    summary: { powered_clinics: 20, total_clinics: 20, active_feeders: 6, total_feeders: 6, critical_clinics: 0, warning_clinics: 0, system_health: stale ? 'Unknown' : 'Healthy' },
    feeders: Array.from({ length: 6 }, (_, i) => ({ id: i + 1, name: `Feeder ${i + 1}`, online: true, clinic_count: i < 2 ? 4 : 3, data_quality: 'ok' })),
    clinics: Array.from({ length: 20 }, (_, i) => ({ id: `CL-${String(i + 1).padStart(2, '0')}`, name: `Clinic ${i + 1}`, feeder_id: i % 6 + 1, power_on: true, local_fault: false, temperature_c: stale && i === 0 ? -1 : 4.4, too_cold: false, forecast_rain_next_6h: 0, forecast_wind_next_6h: 12, risk_probability: stale && i === 0 ? null : 0.02, risk_level: stale && i === 0 ? 'Unknown' : 'Safe', data_quality: stale && i === 0 ? 'stale' : 'ok', source: 'simulation', risk_source: 'calibrated_model' }))
  };
  const calls = [];
  window.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    let payload;
    if (url === '/api/auth/config') payload = { auth_mode: required ? 'required' : 'demo', demo: !required };
    else if (url === '/api/auth/me') payload = user;
    else if (url === '/api/auth/login') payload = { user, access_token: 'test-memory-token', expires_in: 3600 };
    else if (url === '/api/state') payload = live;
    else if (url === '/api/simulate') {
      if (failMutation) throw new TypeError('Network request failed');
      const action = JSON.parse(options.body);
      if (action.action === 'trip_feeder') {
        live.feeders[action.feeder_id - 1].online = false;
        live.clinics.filter((c) => c.feeder_id === action.feeder_id).forEach((c) => { c.power_on = false; c.risk_level = 'Warning'; });
        live.summary.powered_clinics = 17; live.summary.active_feeders = 5;
      }
      payload = live;
    } else if (url === '/api/model') payload = { ready: true, model_name: 'XGBoost + sigmoid calibration', dataset: { days: 240, rows: 115080, positive_rate: 0.0266 }, metrics: { pr_auc: 0.38, f2: 0.47, brier: 0.019, roc_auc: 0.754, threshold: 0.164, prevalence: 0.0266 }, calibration: [{ predicted: 0.1, observed: 0.09 }], roc_curve: [{ fpr: 0, tpr: 0 }, { fpr: 1, tpr: 1 }], confusion_matrix: [[10, 1], [1, 2]], feature_importance: [{ feature: 'temperature_c', importance: 0.5 }], notes: [] };
    else if (url === '/api/alerts') payload = { alerts: [] };
    else if (url === '/api/weather') payload = { provider: 'deterministic', fallback: true, stale: false };
    else if (url === '/api/monitoring') payload = { prediction_count: 20, feedback_count: 0, recent_predictions: [], performance: { status: 'not_enough_data' } };
    else if (url === '/api/policy') payload = { medical_status: 'Not validated', validation_status: 'not_validated', deterministic_safeguards: [], roles: {} };
    else if (url === '/api/audit') payload = { entries: [] };
    else throw new Error(`Unexpected API call: ${url}`);
    return { ok: true, status: 200, json: async () => copy(payload) };
  };
  vm.runInContext(code, dom.getInternalVMContext());
  return { dom, window, calls, errors, $: (id) => window.document.getElementById(id) };
}

test('demo loads model and operations, then sends and renders a shared feeder trip', async (t) => {
  const ui = setup(); t.after(() => ui.dom.window.close());
  await until(() => ui.$('prAuc').textContent === '0.380' && !ui.$('refreshButton').disabled);
  assert.equal(ui.$('sessionIdentity').textContent, 'Local demo · auth bypassed');
  assert.equal(ui.$('clinicTableBody').children.length, 20);
  ui.$('tripFeeder').click();
  await until(() => ui.$('poweredClinics').textContent === '17' && !ui.$('refreshButton').disabled);
  const mutation = ui.calls.find((call) => call.url === '/api/simulate');
  assert.deepEqual(JSON.parse(mutation.options.body), { action: 'trip_feeder', feeder_id: 3 });
  assert.equal(ui.$('activeFeeders').textContent, '5');
  assert.deepEqual(ui.errors, []);
});

test('required authentication gates data and clears token/session on logout', async (t) => {
  const ui = setup({ required: true }); t.after(() => ui.dom.window.close());
  await until(() => !ui.$('loginForm').hidden);
  assert.equal(ui.$('dashboard').hidden, true);
  assert(!ui.calls.some((call) => call.url === '/api/state'));
  ui.$('username').value = 'test-user'; ui.$('password').value = 'testing-password';
  ui.$('loginForm').dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !ui.$('dashboard').hidden && ui.$('prAuc').textContent === '0.380');
  assert.equal(ui.calls.find((call) => call.url === '/api/state').options.headers.Authorization, 'Bearer test-memory-token');
  assert.equal(ui.window.localStorage.length, 0);
  assert.equal(ui.window.sessionStorage.length, 0);
  ui.$('logoutButton').click();
  assert.equal(ui.$('dashboard').hidden, true);
  assert.equal(ui.$('password').value, '');
  assert.equal(ui.$('clinicTableBody').querySelectorAll('.clinic-name').length, 0);
});

test('auditor has read-only controls and can read audit history', async (t) => {
  const ui = setup({ role: 'auditor' }); t.after(() => ui.dom.window.close());
  await until(() => ui.$('prAuc').textContent === '0.380' && !ui.$('refreshButton').disabled);
  assert(ui.$('tripFeeder').disabled);
  assert(ui.$('freezeClinic').disabled);
  assert(ui.$('resetSimulation').disabled);
  assert.equal(ui.$('auditSection').hidden, false);
  assert(ui.calls.some((call) => call.url === '/api/audit'));
});

test('stale last-known thermal excursion stays Unknown rather than fresh Critical', async (t) => {
  const ui = setup({ stale: true }); t.after(() => ui.dom.window.close());
  await until(() => ui.$('clinicTableBody').children.length === 20);
  const row = ui.$('clinicTableBody').firstElementChild;
  assert.match(row.textContent, /Unknown/);
  assert.match(row.textContent, /Last known: too cold/);
  assert.match(row.textContent, /Unavailable \/ rules only/);
  assert.doesNotMatch(row.textContent, /Critical/);
});

test('uncertain mutation locks retries until a successful explicit refresh', async (t) => {
  const ui = setup({ failMutation: true }); t.after(() => ui.dom.window.close());
  await until(() => ui.$('prAuc').textContent === '0.380' && !ui.$('refreshButton').disabled);
  ui.$('tripFeeder').click();
  await until(() => !ui.$('globalError').hidden && !ui.$('refreshButton').disabled);
  assert.match(ui.$('errorTitle').textContent, /Outcome uncertain/);
  assert(ui.$('tripFeeder').disabled);
  assert.equal(ui.calls.filter((call) => call.url === '/api/simulate').length, 1);
  ui.$('refreshButton').click();
  await until(() => !ui.$('tripFeeder').disabled);
  assert.equal(ui.calls.filter((call) => call.url === '/api/simulate').length, 1);
});
