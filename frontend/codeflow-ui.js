(function (root) {
  'use strict';

  /*
   * The old control-room shell is still kept in app.js for its API contract.
   * This flag makes the modern learning surface the only visible CodeFlow
   * controller. It keeps the page fast and avoids two players fighting over
   * the same buttons.
   */
  root.CodeFlowModernUI = true;

  var doc = root.document;
  if (!doc || !root.CodeFlowTraceEngine || !root.CodeFlowPlayer) return;

  var $ = function (id) { return doc.getElementById(id); };
  var codeEditor = $('codeEditor');
  var languageSelect = $('languageSelect');
  var visualizeButton = $('visualizeButton');
  if (!codeEditor || !languageSelect || !visualizeButton) return;

  var DEFAULT_SOURCE = [
    'numbers = [2, 7, 11, 15]',
    'total = 0',
    'for i in range(4):',
    '    total = total + numbers[i]',
    'print(total)',
  ].join('\n');

  var ui = {
    trace: null,
    steps: [],
    index: 0,
    previousIndex: 0,
    voiceEnabled: false,
    reducedMotion: root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches,
    loopTokenOffset: 0,
    narrationVariant: 0,
    player: null,
  };

  var el = {
    code: codeEditor,
    language: languageSelect,
    array: $('arrayVisual'),
    pointer: $('pointerVisual'),
    vars: $('variableVisual'),
    map: $('mapVisual'),
    line: $('activeLineNumber'),
    lineCode: $('activeLineCode'),
    title: $('explainTitle'),
    level: $('explainLevelLabel'),
    what: $('whatText'),
    changed: $('changedText'),
    why: $('whyText'),
    next: $('nextText'),
    caption: $('captionText'),
    sceneCaption: $('sceneCaption'),
    teacher: $('teacherText'),
    teacherWrap: $('teacherScript'),
    stage: $('stageScene'),
    stageCard: $('stageCard'),
    stepLabel: $('stepLabel'),
    hint: $('stageHint'),
    roundLabel: $('roundLabel'),
    roundRecap: $('roundRecap'),
    timeline: $('timeline'),
    fill: doc.querySelector('.timeline-fill'),
    thumb: doc.querySelector('.timeline-thumb'),
    percent: $('timelinePercent'),
    progress: $('progressSlider'),
    dockStep: $('dockStepTitle'),
    dockStatus: $('dockStatus'),
    dockProgress: $('dockProgressText'),
    dockTime: $('dockTime'),
    play: $('playButton'),
    voice: $('voiceMute'),
    voiceStatus: $('voiceStatus'),
    voiceSelect: $('voiceSelect'),
    voiceVolume: $('voiceVolume'),
    effectsVolume: $('effectsVolume'),
    effectsMute: $('effectsMute'),
    speed: $('speedSlider'),
    speedValue: $('speedValue'),
    loopBoard: $('loopBoard'),
    loopTicks: $('loopTicks'),
    loopToken: $('loopToken'),
    loopRoundCount: $('loopRoundCount'),
    conditionText: $('conditionText'),
    conditionResult: $('conditionResult'),
    loopAction: $('loopAction'),
    traceMode: $('traceModeBadge'),
    valueTravel: $('valueTravel'),
    summary: $('programSummary'),
    bug: $('breakSummary'),
    modal: $('predictionModal'),
    options: $('predictionOptions'),
    feedback: $('predictionFeedback'),
  };

  function text(value) { return value == null ? '' : String(value); }
  function escapeHtml(value) { return text(value).replace(/[&<>"']/g, function (char) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]); }); }
  function clamp(value, min, max) { var number = Number(value); return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : min; }
  function sourceText() {
    return (codeEditor.innerText || codeEditor.textContent || '').replace(/\u00a0/g, ' ').trim();
  }
  function currentStep() { return ui.steps[ui.index] || {}; }
  function codeAt(line) { return ui.trace && ui.trace.codeLines && ui.trace.codeLines[line - 1] ? ui.trace.codeLines[line - 1] : ''; }
  function stepCount() { return Math.max(1, ui.steps.length); }

  function formatCode(line) {
    var value = escapeHtml(line);
    if (!value) return '&nbsp;';
    return value
      .replace(/\b(for|in|if|else|break|return|while)\b/g, '<span class="kw">$1</span>')
      .replace(/\b(enumerate|range|print|printf|puts|cout)\b/g, '<span class="fn">$1</span>')
      .replace(/(".*?"|'.*?')/g, '<span class="str">$1</span>');
  }

  function renderCode(line) {
    el.code.innerHTML = (ui.trace ? ui.trace.codeLines : DEFAULT_SOURCE.split('\n')).map(function (value, index) {
      return '<span class="code-line ' + (index + 1 === line ? 'active' : '') + '" data-line="' + String(index + 1).padStart(2, '0') + '">' + formatCode(value) + '</span>';
    }).join('');
  }

  function arrayInfo(step) {
    var state = step && step.state ? step.state : {};
    var entry = Object.keys(state).map(function (key) { return { key: key, value: state[key] }; }).find(function (item) { return Array.isArray(item.value); });
    var pointer = Number.isInteger(state.index) ? state.index : Number.isInteger(state.i) ? state.i : null;
    return { name: entry ? entry.key : null, values: entry ? entry.value : [], pointer: pointer };
  }

  function renderArray(step) {
    var info = arrayInfo(step);
    if (!info.name) {
      el.array.classList.add('empty-array');
      el.array.innerHTML = '<span>no array in this trace · watch the variables and loop camera below</span>';
      el.pointer.innerHTML = '';
      return;
    }
    el.array.classList.remove('empty-array');
    el.array.innerHTML = info.values.map(function (value, index) {
      var active = index === info.pointer;
      return '<div class="array-cell ' + (active ? 'active' : '') + '" data-index="' + index + '">' + escapeHtml(value) + '<span class="cell-index">' + index + '</span></div>';
    }).join('');
    el.pointer.innerHTML = info.pointer == null ? '' : '<span class="pointer-label" style="left:' + (info.pointer * 57) + 'px">' + escapeHtml(info.name) + '[' + info.pointer + ']</span>';
  }

  function renderMemory(step) {
    var values = step && step.vars ? step.vars : {};
    var changedTarget = step && step.target ? String(step.target).split('[')[0] : '';
    el.vars.innerHTML = Object.keys(values).map(function (name) {
      var changed = changedTarget === name || name === step.counterName;
      return '<div class="variable-box ' + (changed ? 'changed' : '') + '"><span class="var-name">' + escapeHtml(name) + '</span><span class="var-value">' + escapeHtml(values[name]) + '</span></div>';
    }).join('') || '<span class="muted-memory">empty for now</span>';
    el.map.innerHTML = '<span class="muted-memory">' + (step && step.output && step.output.length ? 'output: ' + escapeHtml(step.output.join(' ')) : 'no output yet') + '</span>';
  }

  function loopState(step) {
    var eventType = String(step && (step.eventType || step.event) || '').toLowerCase();
    var hasLoop = !!(step && (step.loopId || /loop|condition|increment|body/.test(eventType)));
    if (!hasLoop) return null;
    var counter = step.counterAfter != null ? step.counterAfter : step.counterBefore;
    var total = step.totalRounds != null ? step.totalRounds : null;
    var completed = step.completedRounds != null ? step.completedRounds : (step.round != null ? step.round : 0);
    return { eventType: eventType, counter: counter, total: total, completed: completed, name: step.counterName || 'i', condition: step.conditionText || step.source || step.syntaxDetail || 'control-flow condition', result: step.conditionResult, bodyLine: step.bodyLine, teacher: step.teacher || '', generic: step.generic === true };
  }

  function renderLoop(step) {
    var state = loopState(step);
    if (!state) {
      var preview = ui.steps.slice(ui.index).find(function (item) { return item && (item.eventType === 'loop-summary' || (item.generic && (item.eventType === 'condition' || item.eventType === 'increment'))); });
      if (preview) {
        state = loopState(preview);
        state.preview = true;
      }
    }
    if (!state) {
      el.loopBoard.hidden = true;
      return;
    }
    el.loopBoard.hidden = false;
    var total = state.total == null ? Math.max(1, state.completed || 1) : Math.max(1, state.total);
    var tickCount = Math.min(12, total);
    el.loopTicks.innerHTML = Array.from({ length: tickCount }, function (_, index) { return '<i class="loop-tick ' + (index < state.completed ? 'done' : '') + '">' + (index + 1) + '</i>'; }).join('');
    el.loopRoundCount.textContent = state.eventType === 'loop-summary' ? total + ' rounds planned' : state.eventType === 'loop-exit' ? state.completed + ' rounds complete' : 'round ' + (state.completed || 1) + ' / ' + total;
    el.loopToken.textContent = state.counter == null ? state.name : state.name + ' = ' + state.counter;
    el.conditionText.textContent = state.condition;
    el.conditionResult.textContent = state.result == null ? 'ready' : state.result ? 'true · run body' : 'false · stop';
    el.conditionResult.className = 'condition-result ' + (state.result == null ? 'waiting' : state.result ? 'true' : 'false');
    el.loopAction.textContent = state.preview ? 'Teacher plan: after setup, check the condition before round 1.' : state.eventType === 'loop-summary' ? 'Teacher plan: check the condition before round 1.' : state.eventType === 'condition' ? (state.result ? 'Condition passed. The indented body runs now.' : 'Condition failed. The body is skipped.') : state.eventType === 'increment' ? 'The body is done. Now the counter moves, then we check again.' : state.eventType === 'loop-exit' ? (state.result === false ? 'The condition is false now, so the loop cannot start another round.' : 'The loop stopped because break was reached.') : 'The current loop round is running.';
    el.stage.classList.remove('is-condition', 'is-increment', 'is-exit', 'is-body');
    if (state.eventType === 'condition') el.stage.classList.add('is-condition');
    if (state.eventType === 'increment') el.stage.classList.add('is-increment');
    if (state.eventType === 'loop-exit') el.stage.classList.add('is-exit');
    if (state.eventType === 'body') el.stage.classList.add('is-body');
  }

  function teacherTitle(step) {
    var type = String(step && step.eventType || '').toLowerCase();
    if (type === 'loop-summary') return 'Before the loop: here is the plan.';
    if (type === 'condition') return step.conditionResult ? 'The condition is true, so we go inside.' : 'The condition is false, so we stop.';
    if (type === 'increment') return 'The body finished. Now the counter moves.';
    if (type === 'loop-exit') return 'No more rounds: the loop is done.';
    if (type === 'body') return 'Now one indented line does its job.';
    if (type === 'output') return 'The program is showing its result.';
    return step && step.title ? step.title : 'Let us follow this line.';
  }

  function renderExplanation(step) {
    var level = $('levelSelect') ? $('levelSelect').value : 'simple';
    var language = $('narrationLanguage') ? $('narrationLanguage').value : 'English';
    el.line.textContent = String(step.line || 1).padStart(2, '0');
    el.lineCode.textContent = codeAt(step.line) || 'program finished';
    el.title.textContent = teacherTitle(step);
    el.level.textContent = level.charAt(0).toUpperCase() + level.slice(1) + ' explanation · ' + language;
    el.what.textContent = step.what || 'This line is being followed.';
    el.changed.textContent = step.changed || 'No value changed on this line.';
    el.why.textContent = step.why || 'The program follows its instructions in order.';
    el.next.textContent = step.next || 'The next trace event will explain what happens next.';
    var teacherLine = step.teacher || (step.what + ' ' + step.changed);
    if (step.eventType !== 'loop-summary' && step.eventType !== 'condition' && step.eventType !== 'increment' && step.eventType !== 'loop-exit' && ui.steps.slice(ui.index).some(function (item) { return item && item.eventType === 'loop-summary'; })) teacherLine += ' Next, we enter the loop and check its condition.';
    el.teacher.textContent = teacherLine;
    el.caption.textContent = step.teacher || step.caption || step.what || '';
  }

  function renderFrame(index, options) {
    options = options || {};
    ui.index = clamp(index, 0, Math.max(0, ui.steps.length - 1));
    var step = currentStep();
    if (el.traceMode) {
      el.traceMode.textContent = ui.trace && ui.trace.generic ? 'code story · runtime unknown' : 'verified teaching trace';
      el.traceMode.className = 'trace-mode-badge ' + (ui.trace && ui.trace.generic ? 'story' : 'verified');
    }
    renderCode(step.line || 1);
    renderArray(step);
    renderMemory(step);
    renderLoop(step);
    renderExplanation(step);
    var percent = ui.steps.length <= 1 ? 100 : ui.index / (ui.steps.length - 1) * 100;
    el.stepLabel.innerHTML = 'Step ' + String(ui.index + 1).padStart(2, '0') + ' <b>/ ' + ui.steps.length + '</b>';
    el.hint.textContent = step.hint || step.teacher || 'Follow the next trace event';
    el.roundLabel.textContent = step.round ? 'Round ' + step.round : step.eventType === 'loop-summary' ? 'Before round 1' : step.eventType === 'loop-exit' ? 'Exit check' : 'Teacher recap';
    el.roundRecap.textContent = ' ' + (step.teacher || step.next || 'The simulator moves to the next event.');
    el.dockStep.textContent = 'Step ' + String(ui.index + 1).padStart(2, '0') + ' · ' + teacherTitle(step);
    el.dockProgress.textContent = String(ui.index + 1).padStart(2, '0') + ' / ' + ui.steps.length;
    el.dockTime.textContent = '0:' + String(Math.round(ui.index * .8)).padStart(2, '0');
    el.progress.max = Math.max(1, ui.steps.length - 1);
    el.progress.value = ui.index;
    el.timeline.setAttribute('aria-valuemax', Math.max(1, ui.steps.length - 1));
    el.timeline.setAttribute('aria-valuenow', ui.index);
    el.fill.style.width = percent + '%';
    el.thumb.style.left = percent + '%';
    el.percent.textContent = Math.round(percent) + '% complete';
    if (options.announce) el.dockStatus.textContent = 'Showing the next visual step';
  }

  function loopTokenTransform(counter, step) {
    var value = Number(counter);
    if (!Number.isFinite(value)) value = Number(step && step.round || 0) - 1;
    return Math.max(0, value) * 72;
  }

  function makeAnimation(node, from, to, duration) {
    if (!node || typeof node.animate !== 'function' || ui.reducedMotion) return null;
    try {
      var animation = node.animate([from, to], { duration: duration || 520, easing: 'cubic-bezier(.22,.8,.25,1)', fill: 'both' });
      return animation;
    } catch (_) { return null; }
  }

  function animateFrame(previous, next, transition) {
    var animations = [];
    var previousLoop = loopState(previous);
    var nextLoop = loopState(next);
    var fromOffset = ui.loopTokenOffset;
    var toOffset = nextLoop ? loopTokenTransform(nextLoop.counter, next) : fromOffset;
    if (nextLoop && el.loopToken) {
      el.loopToken.style.transform = 'translateX(' + fromOffset + 'px)';
      var tokenAnimation = makeAnimation(el.loopToken, { transform: 'translateX(' + fromOffset + 'px)' }, { transform: 'translateX(' + toOffset + 'px)' }, 520);
      if (tokenAnimation) animations.push(tokenAnimation);
      ui.loopTokenOffset = toOffset;
    }
    var activeCell = el.array.querySelector('.array-cell.active');
    if (activeCell) {
      var cellAnimation = makeAnimation(activeCell, { transform: 'scale(.88)', opacity: .45 }, { transform: 'scale(1)', opacity: 1 }, 420);
      if (cellAnimation) animations.push(cellAnimation);
    }
    if (next && next.eventType === 'increment') {
      el.loopBoard.classList.remove('is-moving');
      void el.loopBoard.offsetWidth;
      el.loopBoard.classList.add('is-moving');
    }
    if (next && next.eventType === 'condition') {
      var conditionAnimation = makeAnimation(el.conditionResult, { transform: 'scale(.8)', opacity: .45 }, { transform: 'scale(1)', opacity: 1 }, 360);
      if (conditionAnimation) animations.push(conditionAnimation);
    }
    var changed = el.vars.querySelector('.variable-box.changed');
    if (changed) {
      var valueAnimation = makeAnimation(changed, { transform: 'translateY(6px) scale(.94)', opacity: .4 }, { transform: 'translateY(0) scale(1)', opacity: 1 }, 380);
      if (valueAnimation) animations.push(valueAnimation);
    }
    if (el.valueTravel && next) {
      var valueText = next.target ? String(next.target) : next.eventType === 'increment' ? (next.counterName || 'counter') : next.eventType === 'condition' ? 'check' : next.generic ? 'source line' : 'value';
      el.valueTravel.classList.remove('active');
      el.valueTravel.querySelector('span').textContent = valueText;
      void el.valueTravel.offsetWidth;
      el.valueTravel.classList.add('active');
    }
    var activeLine = el.code.querySelector('.code-line.active');
    if (activeLine) {
      var lineAnimation = makeAnimation(activeLine, { transform: 'translateX(-5px)', opacity: .55 }, { transform: 'translateX(3px)', opacity: 1 }, 420);
      if (lineAnimation) animations.push(lineAnimation);
    }
    if (el.teacherWrap) {
      var teacherAnimation = makeAnimation(el.teacherWrap, { transform: 'translateY(5px)', opacity: .55 }, { transform: 'translateY(0)', opacity: 1 }, 360);
      if (teacherAnimation) animations.push(teacherAnimation);
    }
    return animations;
  }

  function shortNarration(index) {
    var step = ui.steps[index] || {};
    var sentences = [];
    var teacher = step.teacher || step.what || '';
    if (teacher) sentences.push({ text: teacher, field: 'teacher' });
    if (step.eventType === 'increment') sentences.push({ text: step.changed || 'The counter moves to the next value.', field: 'changed' });
    else if (step.eventType === 'condition') sentences.push({ text: step.why || 'The condition decides whether the body runs.', field: 'why' });
    else if (step.next) sentences.push({ text: step.next, field: 'next' });
    return sentences;
  }

  function highlightCaption(field) {
    [el.teacherWrap, el.what, el.changed, el.why, el.next].forEach(function (node) { if (node) node.classList.remove('sentence-highlight', 'is-speaking'); });
    if (field === 'teacher') el.teacherWrap.classList.add('is-speaking');
    if (field === 'what') el.what.classList.add('sentence-highlight');
    if (field === 'changed') el.changed.classList.add('sentence-highlight');
    if (field === 'why') el.why.classList.add('sentence-highlight');
    if (field === 'next') el.next.classList.add('sentence-highlight');
  }

  function onState(state) {
    if (el.play) el.play.textContent = state.playing ? 'Ⅱ' : '▶';
    if (el.dockStatus && state.status) {
      var labels = { ready: 'Ready · captions are on', playing: 'Playing like a short lesson', paused: 'Paused · choose next or play', complete: 'Lesson complete · nice work', speaking: 'Browser voice speaking · captions stay on', 'speech-unavailable': 'Voice unavailable · captions only', 'speech-timeout': 'Voice took too long · captions continue' };
      el.dockStatus.textContent = labels[state.status] || state.status;
    }
    if (state.index !== ui.index && ui.steps[state.index]) renderFrame(state.index, { announce: false });
  }

  function onEffectVisual(kind) {
    if (!el.stage) return;
    el.stage.dataset.effect = kind;
    el.stage.classList.remove('effect-beat');
    void el.stage.offsetWidth;
    el.stage.classList.add('effect-beat');
  }

  function createPlayer() {
    ui.player = root.CodeFlowPlayer.create({
      durationMs: 2600,
      pauseBetweenStepsMs: 650,
      speechLeadInMs: 450,
      speed: Number(el.speed && el.speed.value || 0.65),
      metadata: { mode: 'simple', level: 'simple' },
      voiceVolume: Number(el.voiceVolume.value || .9),
      effectsVolume: Number(el.effectsVolume.value || .45),
      speakWithProvider: typeof root.CodeFlowNaturalVoice === 'function' ? function (sentence, context) {
        return root.CodeFlowNaturalVoice(sentence, context);
      } : null,
      onStep: function (index, transition) {
        var previous = ui.steps[ui.index] || null;
        ui.previousIndex = ui.index;
        renderFrame(index, { announce: true });
        var animations = animateFrame(previous, ui.steps[index], transition);
        return animations;
      },
      getNarration: shortNarration,
      onCaption: function (caption, field) {
        if (caption) el.caption.textContent = caption;
        highlightCaption(field);
      },
      onState: onState,
      onEffectVisual: onEffectVisual,
    });
    if (typeof root.CodeFlowNaturalVoice === 'function') ui.player.setVoiceProviderEnabled(true);
    ui.player.setSpeed(Number(el.speed.value || 0.65));
    ui.player.setPauseBetweenSteps(650);
    return ui.player;
  }

  function availableVoices() {
    try {
      if (root.speechSynthesis && typeof root.speechSynthesis.getVoices === 'function') return root.speechSynthesis.getVoices() || [];
    } catch (_) {}
    return [];
  }

  function populateVoices() {
    if (!el.voiceSelect) return;
    var voices = availableVoices().filter(function (voice) { return voice && voice.voiceURI; });
    voices.sort(function (left, right) {
      var leftScore = /google|microsoft|samantha|daniel|karen|aria|neural/i.test(left.name || '') ? 0 : 1;
      var rightScore = /google|microsoft|samantha|daniel|karen|aria|neural/i.test(right.name || '') ? 0 : 1;
      return leftScore - rightScore || String(left.name).localeCompare(String(right.name));
    });
    var previous = el.voiceSelect.value;
    el.voiceSelect.innerHTML = '<option value="">Browser voice · automatic</option>' + voices.map(function (voice) {
      var language = voice.lang ? ' · ' + voice.lang : '';
      return '<option value="' + escapeHtml(voice.voiceURI) + '">' + escapeHtml(voice.name + language) + '</option>';
    }).join('');
    if (voices.some(function (voice) { return voice.voiceURI === previous; })) el.voiceSelect.value = previous;
  }

  function clearErrorState() {
    el.title.classList.remove('error-title');
    el.teacherWrap.classList.remove('error-teacher');
  }

  function showTraceError(result) {
    clearErrorState();
    el.loopBoard.hidden = true;
    el.title.textContent = 'Let us fix one small thing first.';
    el.hint.textContent = 'The safe teaching parser needs a supported pattern';
    el.teacher.textContent = result.error.message;
    el.what.textContent = result.error.message;
    el.changed.textContent = 'Nothing changed because the lesson did not start.';
    el.why.textContent = 'CodeFlow does not run pasted code. It reads a bounded teaching subset so the animation stays safe.';
    el.next.textContent = 'Try the supported example shown in the README or simplify this line, then press Visualize again.';
    el.caption.textContent = result.error.message;
    el.dockStatus.textContent = 'Needs a small syntax change';
    el.teacherWrap.classList.add('error-teacher');
  }

  function loadSource() {
    var source = sourceText();
    if (!source) {
      showTraceError({ error: { message: 'Paste a small program first. Then I will walk through it like a teacher.' } });
      return;
    }
    if (ui.player) ui.player.pause();
    var result = root.CodeFlowTraceEngine.createTrace(source, el.language.value);
    if (result.error) {
      ui.trace = result;
      ui.steps = [];
      showTraceError(result);
      return;
    }
    clearErrorState();
    ui.trace = result;
    ui.steps = result.steps.slice();
    ui.index = 0;
    ui.previousIndex = 0;
    ui.loopTokenOffset = 0;
    if (ui.player) ui.player.load(ui.steps);
    el.summary.textContent = result.summary;
    el.bug.textContent = 'Try changing one input and predict whether the condition will stay true or become false.';
    el.stageCard.classList.add('cinematic');
    el.dockStatus.textContent = 'Ready · press Play for the short lesson';
  }

  function resetSource() {
    if (ui.player) ui.player.pause();
    languageSelect.value = 'Python';
    ui.trace = root.CodeFlowTraceEngine.createTrace(DEFAULT_SOURCE, 'Python');
    ui.steps = ui.trace.steps.slice();
    codeEditor.textContent = DEFAULT_SOURCE;
    if (ui.player) ui.player.load(ui.steps);
    el.summary.textContent = ui.trace.summary;
    el.dockStatus.textContent = 'Ready · press Play for the short lesson';
  }

  function unlockAnd(action) {
    if (!ui.player) return;
    ui.player.unlock();
    action();
  }

  function bind() {
    visualizeButton.addEventListener('click', function () { unlockAnd(loadSource); });
    var reset = $('resetCode');
    if (reset) reset.addEventListener('click', function () { unlockAnd(resetSource); });
    if (el.play) el.play.addEventListener('click', function () { unlockAnd(function () { ui.player.isPlaying ? ui.player.pause() : ui.player.play(); }); });
    var next = $('nextButton');
    if (next) next.addEventListener('click', function () { unlockAnd(function () { ui.player.next(); }); });
    var previous = $('backButton');
    if (previous) previous.addEventListener('click', function () { unlockAnd(function () { ui.player.previous(); }); });
    if (el.progress) el.progress.addEventListener('input', function () { unlockAnd(function () { ui.player.seek(Number(el.progress.value), { speak: false, animate: true }); }); });
    if (el.timeline) el.timeline.addEventListener('click', function (event) {
      var rect = el.timeline.getBoundingClientRect();
      var ratio = rect.width ? (event.clientX - rect.left) / rect.width : 0;
      unlockAnd(function () { ui.player.seek(Math.round(clamp(ratio, 0, 1) * Math.max(0, ui.steps.length - 1)), { speak: false, animate: true }); });
    });
    var repeat = $('repeatButton');
    if (repeat) repeat.addEventListener('click', function () { unlockAnd(function () { ui.player.repeat(); }); });
    var voice = el.voice;
    if (voice) voice.addEventListener('click', function () {
      unlockAnd(function () {
        ui.voiceEnabled = !ui.voiceEnabled;
        ui.player.setVoiceEnabled(ui.voiceEnabled);
        voice.textContent = ui.voiceEnabled ? '◉' : '◖';
        voice.setAttribute('aria-label', ui.voiceEnabled ? 'Turn browser voice off' : 'Turn browser voice on');
        el.voiceStatus.textContent = ui.voiceEnabled ? 'browser voice · captions on' : 'voice off · captions on';
      });
    });
    if (el.voiceVolume) el.voiceVolume.addEventListener('input', function () { ui.player.setVoiceVolume(Number(el.voiceVolume.value)); });
    if (el.voiceSelect) el.voiceSelect.addEventListener('change', function () { ui.player.setVoice(el.voiceSelect.value || null); });
    if (el.effectsVolume) el.effectsVolume.addEventListener('input', function () { ui.player.setEffectsVolume(Number(el.effectsVolume.value)); });
    if (el.effectsMute) el.effectsMute.addEventListener('click', function () { unlockAnd(function () { var muted = el.effectsMute.dataset.muted !== 'true'; el.effectsMute.dataset.muted = muted ? 'true' : 'false'; el.effectsMute.textContent = muted ? '○' : '⌁'; ui.player.setEffectsMuted(muted); }); });
    if (el.speed) el.speed.addEventListener('input', function () { var value = Number(el.speed.value); el.speedValue.textContent = value.toFixed(1) + '×'; ui.player.setSpeed(value); });
    if (root.speechSynthesis) {
      populateVoices();
      root.speechSynthesis.onvoiceschanged = populateVoices;
    }
    var different = $('differentButton');
    if (different) different.addEventListener('click', function () {
      ui.narrationVariant += 1;
      var step = currentStep();
      var original = step.what || 'This line is doing one small job.';
      var analogy = ui.narrationVariant % 2 ? 'Imagine a teacher pointing to one card in a row. ' : 'Imagine checking one drawer at a time. ';
      el.what.textContent = analogy + original;
      el.caption.textContent = analogy + original;
      el.dockStatus.textContent = 'New analogy ready · no waiting';
      unlockAnd(function () { ui.player.speak(analogy + original); });
    });
    var prediction = $('predictionButton');
    if (prediction) prediction.addEventListener('click', function () { openPrediction(); });
    if (el.options) el.options.addEventListener('click', choosePrediction);
    var closePrediction = $('closePrediction');
    if (closePrediction) closePrediction.addEventListener('click', function () { el.modal.hidden = true; });
    var help = $('helpButton');
    if (help) help.addEventListener('click', function () { $('helpModal').hidden = false; });
    var closeHelp = $('closeHelp');
    if (closeHelp) closeHelp.addEventListener('click', function () { $('helpModal').hidden = true; });
    var theme = $('themeButton');
    if (theme) theme.addEventListener('click', function () { doc.body.classList.toggle('warm-mode'); });
    var concept = $('conceptLink');
    if (concept) concept.addEventListener('click', function () { el.teacher.textContent = 'A loop is like checking every drawer in a cabinet. The condition is the rule that says whether we open the next drawer.'; el.caption.textContent = el.teacher.textContent; });
    var closeConcept = $('closeConcept');
    if (closeConcept) closeConcept.addEventListener('click', function () { var card = $('conceptStrip'); if (card) card.hidden = true; });
    doc.addEventListener('keydown', function (event) {
      if (event.target && event.target.matches && event.target.matches('input,select,textarea,[contenteditable="true"]')) return;
      if (event.key === ' ') { event.preventDefault(); unlockAnd(function () { ui.player.isPlaying ? ui.player.pause() : ui.player.play(); }); }
      if (event.key === 'ArrowRight') unlockAnd(function () { ui.player.next(); });
      if (event.key === 'ArrowLeft') unlockAnd(function () { ui.player.previous(); });
      if (event.key.toLowerCase() === 'r') unlockAnd(function () { ui.player.repeat(); });
    });
  }

  function openPrediction() {
    var step = currentStep();
    var state = step.state || {};
    var name = step.counterName || Object.keys(state).find(function (key) { return key === 'i' || key === 'index'; }) || 'value';
    var current = step.counterAfter != null ? step.counterAfter : state[name];
    var candidates = [current, Number(current) + 1, Number(current) + 2].filter(function (value, index, array) { return value != null && array.indexOf(value) === index; });
    if (candidates.length < 3) candidates = [current, 0, 1].filter(function (value, index, array) { return array.indexOf(value) === index; });
    el.modal.hidden = false;
    $('predictionTitle').innerHTML = 'What will <code>' + escapeHtml(name) + '</code> be next?';
    $('predictionPrompt').textContent = step.eventType === 'increment' ? 'The loop is about to move. Pick the next counter value.' : 'Look at the condition and the current value. Make a prediction.';
    el.feedback.textContent = '';
    el.options.innerHTML = candidates.slice(0, 3).map(function (value) { return '<button class="prediction-option" type="button" data-answer="' + escapeHtml(value) + '">' + escapeHtml(value) + '</button>'; }).join('');
  }

  function choosePrediction(event) {
    var button = event.target.closest('[data-answer]');
    if (!button) return;
    var step = currentStep();
    var expected = step.counterAfter != null ? String(step.counterAfter) : '';
    var correct = button.dataset.answer === expected;
    el.feedback.textContent = correct ? '✓ Good prediction. The next value is ' + expected + '.' : 'Not quite. The trace shows ' + (expected || 'the next value') + '. ' + (step.why || 'The loop follows its increment.');
    el.options.querySelectorAll('button').forEach(function (item) { item.disabled = true; });
    if (ui.player) { ui.player.unlock(); ui.player.speak(el.feedback.textContent); }
  }

  function initialise() {
    codeEditor.textContent = DEFAULT_SOURCE;
    ui.trace = root.CodeFlowTraceEngine.createTrace(DEFAULT_SOURCE, 'Python');
    ui.steps = ui.trace.steps.slice();
    ui.player = createPlayer();
    ui.player.load(ui.steps);
    renderFrame(0, { announce: false });
    el.summary.textContent = ui.trace.summary;
    bind();
    root.CodeFlowApplyUserTrace = loadSource;
    root.CodeFlowResetSource = resetSource;
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', initialise, { once: true });
  else initialise();
}(typeof window !== 'undefined' ? window : this));
