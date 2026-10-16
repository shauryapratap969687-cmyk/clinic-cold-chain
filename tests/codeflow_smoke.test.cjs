const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'frontend/app.js'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'frontend/trace-engine.js'), 'utf8');
const playerSource = fs.readFileSync(path.join(root, 'frontend/lesson-player.js'), 'utf8');
const modernUiSource = fs.readFileSync(path.join(root, 'frontend/codeflow-ui.js'), 'utf8');
const visualizer = source.slice(source.indexOf('/* CodeFlow visual lesson'));

test('CodeFlow controls update the visual lesson', () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const errors = [];
  dom.window.addEventListener('error', (event) => errors.push(event.error));
  dom.window.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  vm.runInContext(visualizer, dom.getInternalVMContext());
  const $ = (id) => dom.window.document.getElementById(id);
  assert.equal($('stepLabel').textContent.replace(/\s+/g, ' ').trim(), 'Step 01 / 12');
  $('nextButton').click();
  assert.equal($('stepLabel').textContent.replace(/\s+/g, ' ').trim(), 'Step 02 / 12');
  assert.match($('whatText').textContent, /stores the total/i);
  $('predictionButton').click();
  assert.equal($('predictionModal').hidden, false);
  assert.equal($('predictionOptions').children.length, 3);
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('a learner can enter custom Python, C++, and C code', () => {
  const samples = [
    ['Python', 'total = 0\nfor i in range(3):\n    total = total + i\nprint(total)'],
    ['C++', 'int main() { int total = 0; for (int i = 0; i < 3; i++) { total += i; } std::cout << total; }'],
    ['C', 'int main() { int x = 2; x = x + 3; printf("%d", x); }'],
  ];
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  vm.runInContext(engine, dom.getInternalVMContext());
  vm.runInContext(visualizer, dom.getInternalVMContext());
  const editor = dom.window.document.getElementById('codeEditor');
  const language = dom.window.document.getElementById('languageSelect');
  const visualize = dom.window.document.getElementById('visualizeButton');
  for (const [name, code] of samples) {
    language.value = name;
    editor.textContent = code;
    visualize.click();
    assert.match(dom.window.document.getElementById('stepLabel').textContent, /Step 01/);
    assert.doesNotMatch(dom.window.document.getElementById('explainTitle').textContent, /could not trace/i, name);
  }
  dom.window.close();
});

test('a pasted Python loop becomes a teacher-like trace and advances safely', async () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const errors = [];
  dom.window.addEventListener('error', (event) => errors.push(event.error || event.message));
  dom.window.addEventListener('unhandledrejection', (event) => errors.push(event.reason));
  dom.window.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  vm.runInContext(engine, dom.getInternalVMContext());
  vm.runInContext(visualizer, dom.getInternalVMContext());

  const $ = (id) => dom.window.document.getElementById(id);
  const source = [
    'total = 0',
    'for i in range(3):',
    '    total = total + i',
    'print(total)',
  ].join('\n');
  $('languageSelect').value = 'Python';
  $('codeEditor').textContent = source;
  $('codeEditor').dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  const expectedTrace = dom.window.CodeFlowTraceEngine.createTrace(source, 'Python');
  assert.equal(expectedTrace.error, undefined);
  assert.ok(expectedTrace.steps.length > 1, 'the loop should produce multiple trace steps');
  assert.ok(expectedTrace.steps.some((step) => step.event === 'loop-start'));
  assert.ok(expectedTrace.steps.some((step) => step.condition && step.condition.result === true));
  assert.ok(expectedTrace.steps.some((step) => step.event === 'loop-increment'));

  $('visualizeButton').click();
  const visibleStepText = $('stepLabel').textContent.replace(/\s+/g, ' ').trim();
  const visibleStepCount = Number(visibleStepText.match(/\/\s*(\d+)/)[1]);
  assert.equal(visibleStepCount, expectedTrace.steps.length);
  assert.ok(visibleStepCount > 1);
  assert.equal($('activeLineNumber').textContent, '01');
  assert.equal($('activeLineCode').textContent, 'total = 0');

  const firstStep = visibleStepText;
  $('nextButton').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.notEqual($('stepLabel').textContent.replace(/\s+/g, ' ').trim(), firstStep);
  assert.equal($('activeLineNumber').textContent, '02');
  assert.equal($('activeLineCode').textContent, 'for i in range(3):');
  const loopExplanation = [
    $('explainTitle').textContent,
    $('whatText').textContent,
    $('changedText').textContent,
    $('whyText').textContent,
    $('nextText').textContent,
    $('stageHint').textContent,
  ].join(' ');
  assert.match(loopExplanation, /loop/i);
  assert.match(loopExplanation, /evaluate|condition/i);

  $('nextButton').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match($('whyText').textContent, /condition/i);

  for (let step = 0; step < 2; step += 1) $('nextButton').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const incrementExplanation = [
    $('whatText').textContent,
    $('changedText').textContent,
    $('whyText').textContent,
    $('nextText').textContent,
  ].join(' ');
  assert.equal($('activeLineNumber').textContent, '02');
  assert.match(incrementExplanation, /increment/i);

  const beforePlay = $('stepLabel').textContent.replace(/\s+/g, ' ').trim();
  $('playButton').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  $('playButton').click();
  assert.notEqual($('stepLabel').textContent.replace(/\s+/g, ' ').trim(), beforePlay);
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('a C++ loop exposes condition and increment steps through the public trace flow', () => {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const errors = [];
  dom.window.addEventListener('error', (event) => errors.push(event.error || event.message));
  dom.window.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  vm.runInContext(engine, dom.getInternalVMContext());
  vm.runInContext(visualizer, dom.getInternalVMContext());

  const $ = (id) => dom.window.document.getElementById(id);
  const source = [
    'int main() {',
    '  int total = 0;',
    '  for (int i = 0; i < 3; i++) {',
    '    total += i;',
    '  }',
    '  std::cout << total;',
    '}',
  ].join('\n');
  $('languageSelect').value = 'C++';
  $('codeEditor').textContent = source;
  $('visualizeButton').click();

  const trace = dom.window.CodeFlowTraceEngine.createTrace(source, 'C++');
  assert.equal(trace.error, undefined);
  assert.ok(trace.steps.length > 1);
  assert.ok(trace.steps.some((step) => step.event === 'loop-start'));
  assert.ok(trace.steps.some((step) => step.condition && step.condition.operator === '<'));
  assert.ok(trace.steps.some((step) => step.event === 'loop-increment'));
  assert.match($('stepLabel').textContent, /Step 01 \/ \d+/);
  assert.doesNotMatch($('explainTitle').textContent, /could not trace/i);
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('CodeFlow still boots when the browser provides IntersectionObserver', async () => {
  const dom = new JSDOM(html, { url: 'http://localhost:8000', runScripts: 'outside-only', pretendToBeVisual: true });
  const errors = [];
  dom.window.addEventListener('error', (event) => errors.push(event.error));
  dom.window.IntersectionObserver = class { observe(target) { assert.ok(target); } disconnect() {} };
  dom.window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {}, set: () => true });
  const state = { summary: {}, feeders: [], clinics: [], timestamp: '2025-01-01T00:00:00Z' };
  dom.window.fetch = async (url) => {
    const payloads = {
      '/api/auth/config': { auth_mode: 'demo', demo: true },
      '/api/auth/me': { username: 'demo', role: 'admin' },
      '/api/state': state,
      '/api/model': { ready: false },
      '/api/alerts': { alerts: [] },
      '/api/weather': {},
      '/api/monitoring': { recent_predictions: [] },
      '/api/policy': { roles: [] },
      '/api/audit': { entries: [] },
    };
    return { ok: true, status: 200, json: async () => payloads[url] || {} };
  };
  vm.runInContext(source, dom.getInternalVMContext());
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(errors, []);
  assert.equal(dom.window.document.getElementById('nextButton').disabled, false);
  dom.window.close();
});

test('the modern cinematic UI shows the loop camera and increments the counter', async () => {
  const dom = new JSDOM(html, { url: 'http://localhost:8000', runScripts: 'outside-only', pretendToBeVisual: true });
  const errors = [];
  dom.window.addEventListener('error', (event) => errors.push(event.error || event.message));
  dom.window.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  vm.runInContext(engine, dom.getInternalVMContext());
  vm.runInContext(playerSource, dom.getInternalVMContext());
  vm.runInContext(modernUiSource, dom.getInternalVMContext());
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const $ = (id) => dom.window.document.getElementById(id);
  $('codeEditor').textContent = 'total = 0\nfor i in range(2):\n    total = total + i\nprint(total)';
  $('visualizeButton').click();
  assert.equal($('loopBoard').hidden, false);
  assert.match($('teacherText').textContent, /loop|round|condition/i);
  assert.match($('conditionText').textContent, /i/);
  assert.match($('loopAction').textContent, /condition|counter|body/i);
  $('nextButton').click();
  $('nextButton').click();
  assert.match($('stepLabel').textContent, /Step 0[23]/);
  $('languageSelect').value = 'C++';
  $('codeEditor').textContent = 'int main() { int total = 0; for (int i = 0; i < 2; i++) { total += i; } std::cout << total; }';
  $('visualizeButton').click();
  assert.equal($('loopBoard').hidden, false);
  assert.doesNotMatch($('explainTitle').textContent, /fix one small thing/i);
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('arbitrary language code gets an honest generic code-story trace', async () => {
  const dom = new JSDOM(html, { url: 'http://localhost:8000', runScripts: 'outside-only', pretendToBeVisual: true });
  const errors = [];
  dom.window.addEventListener('error', (event) => errors.push(event.error || event.message));
  dom.window.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  vm.runInContext(engine, dom.getInternalVMContext());
  vm.runInContext(playerSource, dom.getInternalVMContext());
  vm.runInContext(modernUiSource, dom.getInternalVMContext());
  dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const $ = (id) => dom.window.document.getElementById(id);
  $('languageSelect').value = 'JavaScript';
  $('codeEditor').textContent = 'function sum(values) {\n  let total = 0;\n  for (let i = 0; i < values.length; i++) {\n    total += values[i];\n  }\n  return total;\n}';
  $('visualizeButton').click();
  assert.match($('traceModeBadge').textContent, /code story/i);
  assert.match($('teacherText').textContent, /generic|syntax|runtime/i);
  assert.match($('stepLabel').textContent, /Step 01 \/ \d+/);
  assert.equal($('loopBoard').hidden, false);
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('default lesson pacing is deliberately calm', () => {
  assert.equal(domSpeedValue(), '0.65');
  function domSpeedValue() {
    const match = html.match(/id="speedSlider"[^>]*value="([^"]+)"/);
    return match && match[1];
  }
});
