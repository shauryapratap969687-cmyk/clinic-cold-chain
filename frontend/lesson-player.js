(function (root) {
  'use strict';

  /*
   * CodeFlowPlayer is deliberately independent of the page that hosts it.
   * The caller owns rendering and creates any Web Animations returned by
   * onStep.  This file only coordinates those animations, captions, speech,
   * and optional effects.
   */

  var DEFAULT_DURATION = 2300;
  var DEFAULT_MOTION_DURATION = 900;
  var DEFAULT_PAUSE_BETWEEN_STEPS = 450;
  var DEFAULT_SPEECH_LEAD_IN = 250;
  var DEFAULT_SPEED = 0.7;
  var MIN_SPEED = 0.35;
  var MAX_SPEED = 1.6;
  var MAX_NARRATION_SENTENCES = 8;
  var MAX_TEXT_LENGTH = 500;

  function noop() {}

  function finiteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function clamp(value, min, max, fallback) {
    var number = Number(value);
    if (!finiteNumber(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }

  function clampIndex(value, length) {
    if (!length) return 0;
    var number = Number(value);
    if (!finiteNumber(number)) number = 0;
    number = Math.round(number);
    return Math.max(0, Math.min(length - 1, number));
  }

  function text(value) {
    if (value == null) return '';
    return String(value).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LENGTH);
  }

  function safeCall(callback, args) {
    if (typeof callback !== 'function') return undefined;
    try {
      return callback.apply(null, args || []);
    } catch (_) {
      return undefined;
    }
  }

  function safePromise(value) {
    if (typeof Promise === 'function') return Promise.resolve(value);
    return value;
  }

  function copyValue(value, depth) {
    if (!value || typeof value !== 'object') return value;
    if (depth > 4) return value;
    if (Array.isArray(value)) {
      return value.map(function (item) { return copyValue(item, depth + 1); });
    }
    var result = {};
    Object.keys(value).forEach(function (key) {
      try { result[key] = copyValue(value[key], depth + 1); } catch (_) {}
    });
    return result;
  }

  function objectValue(value, keys) {
    if (!value || typeof value !== 'object') return undefined;
    for (var i = 0; i < keys.length; i += 1) {
      if (value[keys[i]] != null) return value[keys[i]];
    }
    return undefined;
  }

  function asLower(value) {
    return text(value).toLowerCase().replace(/[\s_]+/g, '-');
  }

  function isSimpleValue(value) {
    var normalized = asLower(value);
    return normalized === 'simple' || normalized === 'simple-mode' || normalized === 'beginner' || normalized === 'basic';
  }

  function hasSimpleMetadata(value, depth) {
    if (depth > 4 || value == null) return false;
    if (typeof value === 'string') return isSimpleValue(value);
    if (typeof value !== 'object') return false;
    if (value.simple === true || value.isSimple === true || value.simpleMode === true) return true;
    var keys = ['mode', 'level', 'explanationMode', 'teachingMode', 'detailLevel', 'complexity'];
    for (var i = 0; i < keys.length; i += 1) {
      var item;
      try { item = value[keys[i]]; } catch (_) { item = undefined; }
      if (isSimpleValue(item) || hasSimpleMetadata(item, depth + 1)) return true;
    }
    try {
      if (value.metadata && hasSimpleMetadata(value.metadata, depth + 1)) return true;
    } catch (_) {}
    return false;
  }

  function mergeMetadata(base, extra) {
    var result = {};
    if (base && typeof base === 'object' && !Array.isArray(base)) {
      Object.keys(base).forEach(function (key) { result[key] = copyValue(base[key], 1); });
    }
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
      Object.keys(extra).forEach(function (key) { result[key] = copyValue(extra[key], 1); });
    } else if (extra != null && (typeof extra !== 'object' || Array.isArray(extra))) {
      result.mode = copyValue(extra, 1);
    }
    return result;
  }

  function getSpeechSynthesis(host) {
    try {
      return host && host.speechSynthesis ? host.speechSynthesis : null;
    } catch (_) {
      return null;
    }
  }

  function getUtteranceConstructor(host) {
    try {
      return host && (host.SpeechSynthesisUtterance || (host.window && host.window.SpeechSynthesisUtterance));
    } catch (_) {
      return null;
    }
  }

  function create(options) {
    options = options && typeof options === 'object' ? options : {};

    var host = root || {};
    var documentRef = null;
    try { documentRef = host.document || null; } catch (_) { documentRef = null; }

    var onStep = typeof options.onStep === 'function' ? options.onStep : noop;
    var getNarration = typeof options.getNarration === 'function' ? options.getNarration : null;
    var onCaption = typeof options.onCaption === 'function' ? options.onCaption : noop;
    var onState = typeof options.onState === 'function' ? options.onState : noop;
    var onEffectVisual = typeof options.onEffectVisual === 'function' ? options.onEffectVisual : noop;

    var durationMs = clamp(options.durationMs, 0, 120000, DEFAULT_DURATION);
    var pauseBetweenStepsMs = clamp(options.pauseBetweenStepsMs, 0, 120000, DEFAULT_PAUSE_BETWEEN_STEPS);
    var speechLeadInMs = clamp(options.speechLeadInMs, 0, 120000, DEFAULT_SPEECH_LEAD_IN);
    var steps = [];
    var currentIndex = 0;
    var playing = false;
    var speed = options.speed == null ? DEFAULT_SPEED : clamp(options.speed, MIN_SPEED, MAX_SPEED, DEFAULT_SPEED);
    var voiceEnabled = false;
    var voiceMode = 'captions';
    var voiceProviderEnabled = false;
    var speakWithProvider = typeof options.speakWithProvider === 'function' ? options.speakWithProvider : null;
    var defaultSpeechMetadata = options.metadata && typeof options.metadata === 'object' && !Array.isArray(options.metadata) ? mergeMetadata(options.metadata, null) : options.metadata == null ? {} : { mode: copyValue(options.metadata, 1) };
    ['mode', 'level', 'explanationMode', 'teachingMode', 'simple', 'isSimple', 'simpleMode'].forEach(function (key) {
      if (options[key] != null) defaultSpeechMetadata[key] = copyValue(options[key], 1);
    });
    var selectedVoiceUri = null;
    var voiceVolume = clamp(options.voiceVolume, 0, 1, 1);
    var effectsMuted = false;
    var effectsVolume = clamp(options.effectsVolume, 0, 1, 0.45);
    var status = 'idle';
    var destroyed = false;
    var visible = true;

    var transition = null;
    var callbackToken = 0;
    var frameId = null;
    var frameSerial = 0;
    var previousFrameTime = null;

    var speechSynthesis = getSpeechSynthesis(host);
    var SpeechSynthesisUtterance = getUtteranceConstructor(host);
    var speech = {
      serial: 0,
      active: null,
      queue: [],
      cursor: 0,
      owner: null,
      resolver: null,
      settled: false,
      metadata: null,
      fallbackToBrowser: false,
    };

    var audioContext = null;
    var audioUnlocked = false;
    var audioUnavailable = false;

    var api;

    function snapshot() {
      return {
        index: currentIndex,
        playing: playing,
        speed: speed,
        voiceEnabled: voiceEnabled,
        voiceMode: voiceMode,
        status: status,
      };
    }

    function announceState(nextStatus) {
      if (nextStatus !== undefined) status = nextStatus;
      if (!destroyed) safeCall(onState, [snapshot()]);
    }

    function setStatus(nextStatus, announce) {
      status = nextStatus;
      if (announce !== false) announceState();
    }

    function getNow() {
      try {
        if (host.performance && typeof host.performance.now === 'function') {
          var performanceNow = Number(host.performance.now());
          if (finiteNumber(performanceNow)) return performanceNow;
        }
      } catch (_) {}
      return Date.now();
    }

    function requestAnimationFrameSafe(callback) {
      try {
        if (typeof host.requestAnimationFrame === 'function') return host.requestAnimationFrame(callback);
        if (host.window && typeof host.window.requestAnimationFrame === 'function') return host.window.requestAnimationFrame(callback);
      } catch (_) {}
      return null;
    }

    function cancelAnimationFrameSafe(id) {
      try {
        if (typeof host.cancelAnimationFrame === 'function') host.cancelAnimationFrame(id);
        else if (host.window && typeof host.window.cancelAnimationFrame === 'function') host.window.cancelAnimationFrame(id);
      } catch (_) {}
    }

    function hasClock() {
      return typeof host.requestAnimationFrame === 'function' || !!(host.window && typeof host.window.requestAnimationFrame === 'function');
    }

    function shouldRunClock() {
      return !!transition || !!speech.active || playing;
    }

    function cancelFrame() {
      frameSerial += 1;
      if (frameId !== null) cancelAnimationFrameSafe(frameId);
      frameId = null;
      previousFrameTime = null;
    }

    function scheduleFrame() {
      if (destroyed || frameId !== null || !shouldRunClock()) return;
      if (!hasClock()) {
        playing = false;
        status = 'clock-unavailable';
        announceState();
        return;
      }
      var serial = ++frameSerial;
      frameId = requestAnimationFrameSafe(function (timestamp) {
        if (destroyed || serial !== frameSerial) return;
        frameId = null;
        tick(timestamp);
      });
      if (frameId === null) {
        playing = false;
        status = 'clock-unavailable';
        announceState();
      }
    }

    function animationDuration(animation) {
      var duration;
      try {
        if (animation && animation.effect && typeof animation.effect.getTiming === 'function') {
          duration = animation.effect.getTiming().duration;
        } else if (animation && animation.effect && animation.effect.timing) {
          duration = animation.effect.timing.duration;
        }
      } catch (_) { duration = undefined; }
      if (duration === 'auto') return DEFAULT_MOTION_DURATION;
      duration = Number(duration);
      return finiteNumber(duration) && duration >= 0 ? duration : DEFAULT_MOTION_DURATION;
    }

    function prepareAnimation(animation) {
      if (!animation || (typeof animation !== 'object' && typeof animation !== 'function')) return false;
      try {
        if (typeof animation.pause === 'function') animation.pause();
      } catch (_) {}
      return true;
    }

    function setAnimationTime(animation, value) {
      if (!animation) return;
      try { animation.currentTime = Math.max(0, value); } catch (_) {}
    }

    function cancelAnimation(animation) {
      if (!animation) return;
      try {
        if (typeof animation.cancel === 'function') animation.cancel();
        else if ('currentTime' in animation) animation.currentTime = null;
      } catch (_) {}
    }

    function cleanAnimations() {
      if (!transition || !Array.isArray(transition.animations)) return;
      transition.animations.forEach(cancelAnimation);
      transition.animations.length = 0;
    }

    function normalizeNarration(index) {
      var raw;
      if (getNarration) {
        raw = safeCall(getNarration, [index, copyValue(stepMetadata(index, null), 0)]);
      } else {
        var step = steps[index];
        if (typeof step === 'string') raw = [{ text: step }];
        else if (step && typeof step === 'object') {
          var fallback = objectValue(step, ['caption', 'narration', 'text', 'what', 'title']);
          raw = fallback == null ? [] : Array.isArray(fallback) ? fallback : [{ text: fallback, field: step.field }];
        } else raw = [];
      }

      if (!Array.isArray(raw)) raw = raw == null ? [] : [raw];
      var result = [];
      for (var i = 0; i < raw.length && result.length < MAX_NARRATION_SENTENCES; i += 1) {
        var item = raw[i];
        var sentence = typeof item === 'string' ? { text: item } : item && typeof item === 'object' ? item : null;
        if (!sentence) continue;
        var sentenceText = text(sentence.text);
        if (!sentenceText) continue;
        var normalized = { text: sentenceText, field: sentence.field == null ? null : sentence.field };
        try {
          if (sentence.metadata != null) normalized.metadata = copyValue(sentence.metadata, 0);
          else if (sentence.meta != null) normalized.metadata = copyValue(sentence.meta, 0);
          ['mode', 'level', 'explanationMode', 'teachingMode', 'detailLevel', 'complexity', 'simple', 'isSimple', 'simpleMode'].forEach(function (key) {
            if (sentence[key] != null) {
              if (!normalized.metadata || typeof normalized.metadata !== 'object' || Array.isArray(normalized.metadata)) normalized.metadata = {};
              normalized.metadata[key] = copyValue(sentence[key], 1);
            }
          });
        } catch (_) {}
        result.push(normalized);
      }
      return result;
    }

    function showCaption(owner, cursor) {
      if (!owner || !owner.narration || !owner.narration[cursor]) return;
      if (owner.captionCursor === cursor) return;
      owner.captionCursor = cursor;
      var sentence = owner.narration[cursor];
      safeCall(onCaption, [sentence.text, sentence.field]);
    }

    function speechAvailable() {
      return !!(speechSynthesis && typeof speechSynthesis.speak === 'function' && typeof speechSynthesis.cancel === 'function' && typeof SpeechSynthesisUtterance === 'function');
    }

    function voiceList() {
      if (!speechSynthesis || typeof speechSynthesis.getVoices !== 'function') return [];
      try {
        var result = speechSynthesis.getVoices();
        return Array.isArray(result) ? result.slice() : result && typeof result.length === 'number' ? Array.prototype.slice.call(result) : [];
      } catch (_) {
        return [];
      }
    }

    function selectedVoice() {
      if (!selectedVoiceUri) return null;
      var list = voiceList();
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] && (list[i].voiceURI === selectedVoiceUri || list[i].uri === selectedVoiceUri)) return list[i];
      }
      return null;
    }

    function providerAvailable() {
      return voiceProviderEnabled && typeof speakWithProvider === 'function';
    }

    function setVoiceMode(nextMode, announce) {
      if (nextMode !== 'captions' && nextMode !== 'browser' && nextMode !== 'provider') nextMode = 'captions';
      if (voiceMode === nextMode) return;
      voiceMode = nextMode;
      if (announce !== false) announceState();
    }

    function preferredVoiceMode() {
      if (!voiceEnabled) return 'captions';
      if (providerAvailable()) return 'provider';
      if (speechAvailable()) return 'browser';
      return 'captions';
    }

    function stepMetadata(index, explicitMetadata) {
      var result = mergeMetadata(defaultSpeechMetadata, explicitMetadata);
      var step = steps[index];
      if (step && typeof step === 'object' && !Array.isArray(step)) {
        var metadata;
        try { metadata = step.metadata == null ? step.meta : step.metadata; } catch (_) { metadata = undefined; }
        result = mergeMetadata(result, metadata);
        var hints = {};
        ['mode', 'level', 'explanationMode', 'teachingMode', 'detailLevel', 'complexity', 'simple', 'isSimple', 'simpleMode'].forEach(function (key) {
          try { if (step[key] != null) hints[key] = copyValue(step[key], 1); } catch (_) {}
        });
        result = mergeMetadata(result, hints);
      }
      return result;
    }

    function speechMetadata(owner, metadata) {
      if (metadata && typeof metadata === 'object') return mergeMetadata(defaultSpeechMetadata, metadata);
      if (metadata != null) return mergeMetadata(defaultSpeechMetadata, { mode: copyValue(metadata, 1) });
      if (owner && owner.metadata && typeof owner.metadata === 'object') return mergeMetadata(defaultSpeechMetadata, owner.metadata);
      return mergeMetadata(defaultSpeechMetadata, null);
    }

    function sentenceSpeechMetadata(sentence, owner) {
      var metadata = speechMetadata(owner, speech.metadata);
      return mergeMetadata(metadata, sentence && sentence.metadata);
    }

    function speechRate(owner, metadata) {
      var rate = speed;
      var details = speechMetadata(owner, metadata);
      if (hasSimpleMetadata(defaultSpeechMetadata, 0) || hasSimpleMetadata(owner && owner.metadata, 0) || hasSimpleMetadata(metadata, 0) || hasSimpleMetadata(details, 0)) rate = Math.min(1, rate);
      return clamp(rate, MIN_SPEED, MAX_SPEED, DEFAULT_SPEED);
    }

    function validSpeechOwner(owner) {
      return !owner || (transition === owner && owner.epoch === callbackToken);
    }

    function resolveSpeech(value) {
      var resolver = speech.resolver;
      speech.resolver = null;
      if (typeof resolver === 'function') {
        try { resolver(!!value); } catch (_) {}
      }
    }

    function clearSpeechState() {
      speech.active = null;
      speech.queue = [];
      speech.cursor = 0;
      speech.owner = null;
      speech.settled = true;
      speech.metadata = null;
      speech.fallbackToBrowser = false;
    }

    function isThenable(value) {
      try {
        return !!(value && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function');
      } catch (_) {
        return false;
      }
    }

    function isAudioLike(value) {
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
      try {
        return typeof value.play === 'function' || typeof value.pause === 'function' || typeof value.stop === 'function' || typeof value.addEventListener === 'function' || 'onended' in value || 'onerror' in value;
      } catch (_) {
        return false;
      }
    }

    function providerMedia(value) {
      if (isAudioLike(value)) return value;
      if (!value || typeof value !== 'object') return null;
      var nested;
      try { nested = objectValue(value, ['audio', 'audioElement', 'media', 'element']); } catch (_) { return null; }
      return isAudioLike(nested) ? nested : null;
    }

    function detachProviderMedia(active) {
      if (!active || typeof active.providerCleanup !== 'function') return;
      safeCall(active.providerCleanup);
      active.providerCleanup = null;
    }

    function stopProviderMedia(active) {
      if (!active || !active.providerMedia) return;
      detachProviderMedia(active);
      var media = active.providerMedia;
      ['pause', 'stop', 'cancel'].some(function (method) {
        try {
          if (typeof media[method] === 'function') {
            media[method]();
            return true;
          }
        } catch (_) {}
        return false;
      });
    }

    function cancelSpeech() {
      speech.serial += 1;
      var active = speech.active;
      var owner = speech.owner;
      if (owner && transition === owner && owner.epoch === callbackToken) owner.speechDone = true;
      if (active && active.backend === 'provider') stopProviderMedia(active);
      if (active && active.backend === 'browser' && active.utterance) {
        try { active.utterance.onend = null; active.utterance.onerror = null; } catch (_) {}
        try { speechSynthesis.cancel(); } catch (_) {}
      }
      clearSpeechState();
      resolveSpeech(false);
    }

    function speechWatchdogMs(sentence, rate) {
      var length = sentence && sentence.text ? sentence.text.length : 0;
      var safeRate = Math.max(MIN_SPEED, Number(rate) || DEFAULT_SPEED);
      return Math.max(3500, Math.min(15000, 1800 + length * 70 / safeRate));
    }

    function providerWatchdogMs(sentence, rate) {
      return Math.max(5000, Math.min(18000, speechWatchdogMs(sentence, rate) + 1500));
    }

    function markSpeechDone(owner) {
      if (owner && transition === owner && owner.epoch === callbackToken) {
        owner.speechDone = true;
        owner.speechStarted = false;
        owner.speechPending = false;
      }
    }

    function finishSpeechSentence(serial, result) {
      var active = speech.active;
      if (!active || active.serial !== serial || destroyed) return;

      var owner = active.owner;
      var cursor = speech.cursor;
      var queue = speech.queue;
      var utterance = active.utterance;
      var backend = active.backend;

      speech.active = null;
      if (backend === 'provider') {
        if (result === 'timeout' || result === 'error') stopProviderMedia(active);
        else detachProviderMedia(active);
      }
      if (backend === 'browser') {
        try { utterance.onend = null; utterance.onerror = null; } catch (_) {}
        if (result === 'timeout' || result === 'error') {
          try { speechSynthesis.cancel(); } catch (_) {}
        }
      }

      if (result === 'timeout' || result === 'error') {
        if (backend === 'provider' && validSpeechOwner(owner) && voiceEnabled && speechAvailable()) {
          speech.fallbackToBrowser = true;
          setVoiceMode('browser', false);
          status = 'speaking';
          startSpeechSentence();
          announceState();
          scheduleFrame();
          return;
        }
        if (result === 'timeout') status = 'speech-timeout';
        else status = 'speech-error';
        setVoiceMode(backend === 'browser' ? 'captions' : (speechAvailable() ? 'browser' : 'captions'), false);
        clearSpeechState();
        resolveSpeech(false);
        markSpeechDone(owner);
        announceState();
        return;
      }

      if (cursor + 1 < queue.length) {
        speech.cursor += 1;
        startSpeechSentence();
        return;
      }

      var completedVoiceMode = speech.fallbackToBrowser ? (speechAvailable() ? 'browser' : 'captions') : preferredVoiceMode();
      clearSpeechState();
      resolveSpeech(true);
      markSpeechDone(owner);
      setVoiceMode(completedVoiceMode, false);
      if (playing) status = 'playing';
      else if (!destroyed) status = 'paused';
      announceState();
    }

    function attachProviderMedia(serial, media) {
      var active = speech.active;
      if (!active || active.serial !== serial) return;
      active.providerMedia = media;
      var cleanups = [];
      var hasEndSignal = false;
      var ended = function (event) {
        finishSpeechSentence(serial, 'end');
        return event;
      };
      var failed = function () { finishSpeechSentence(serial, 'error'); };

      try {
        if (typeof media.addEventListener === 'function') {
          media.addEventListener('ended', ended);
          media.addEventListener('error', failed);
          media.addEventListener('abort', failed);
          hasEndSignal = true;
          cleanups.push(function () {
            try { media.removeEventListener('ended', ended); } catch (_) {}
            try { media.removeEventListener('error', failed); } catch (_) {}
            try { media.removeEventListener('abort', failed); } catch (_) {}
          });
        } else if ('onended' in media || 'onerror' in media) {
          var previousEnded = media.onended;
          var previousError = media.onerror;
          media.onended = function (event) {
            safeCall(previousEnded, [event]);
            ended(event);
          };
          media.onerror = function (event) {
            safeCall(previousError, [event]);
            failed(event);
          };
          hasEndSignal = true;
          cleanups.push(function () {
            try { media.onended = previousEnded; } catch (_) {}
            try { media.onerror = previousError; } catch (_) {}
          });
        }
      } catch (_) {}

      active.providerHasEndSignal = hasEndSignal;
      active.providerCleanup = function () {
        cleanups.forEach(function (cleanup) { safeCall(cleanup); });
        cleanups.length = 0;
      };

      try {
        if (media.ended === true) {
          finishSpeechSentence(serial, 'end');
          return;
        }
      } catch (_) {}

      var played;
      if (typeof media.play === 'function') {
        try { played = media.play(); } catch (_) { finishSpeechSentence(serial, 'error'); return; }
        if (played === false) {
          finishSpeechSentence(serial, 'error');
          return;
        }
        if (isThenable(played)) {
          try {
            played.then(function () {
              if (speech.active && speech.active.serial === serial && !hasEndSignal) finishSpeechSentence(serial, 'end');
            }, function () { finishSpeechSentence(serial, 'error'); });
          } catch (_) {
            finishSpeechSentence(serial, 'error');
          }
        }
      } else if (!hasEndSignal) {
        finishSpeechSentence(serial, 'end');
      }
    }

    function handleProviderResult(serial, value, fromPromise) {
      var active = speech.active;
      if (!active || active.serial !== serial || destroyed) return;
      if (value === false || (value == null && !fromPromise)) {
        finishSpeechSentence(serial, 'error');
        return;
      }
      var media = providerMedia(value);
      if (media) {
        attachProviderMedia(serial, media);
        return;
      }
      finishSpeechSentence(serial, 'end');
    }

    function providerContext(sentence, owner) {
      var metadata = sentenceSpeechMetadata(sentence, owner);
      var index = owner && owner.index != null ? owner.index : currentIndex;
      var voice = selectedVoice();
      return {
        index: index,
        field: sentence && sentence.field != null ? sentence.field : null,
        rate: speechRate(owner, metadata),
        speed: speed,
        volume: voiceVolume,
        voiceUri: selectedVoiceUri,
        voice: copyValue(voice, 0),
        voiceMode: 'provider',
        mode: hasSimpleMetadata(metadata, 0) ? 'simple' : (metadata.mode == null ? 'standard' : text(metadata.mode)),
        metadata: copyValue(metadata, 0),
        step: copyValue(steps[index], 0),
      };
    }

    function startProviderSentence(sentence, owner) {
      var serial = ++speech.serial;
      speech.active = {
        serial: serial,
        backend: 'provider',
        owner: owner,
        utterance: null,
        providerMedia: null,
        providerCleanup: null,
        providerHasEndSignal: false,
        remaining: providerWatchdogMs(sentence, speechRate(owner, sentenceSpeechMetadata(sentence, owner))),
      };
      setVoiceMode('provider', false);
      status = 'speaking';
      announceState();
      var result;
      try {
        result = speakWithProvider(sentence.text, providerContext(sentence, owner));
      } catch (_) {
        finishSpeechSentence(serial, 'error');
        return;
      }
      if (!speech.active || speech.active.serial !== serial) return;
      if (isThenable(result)) {
        try {
          result.then(function (value) { handleProviderResult(serial, value, true); }, function () { finishSpeechSentence(serial, 'error'); });
        } catch (_) {
          finishSpeechSentence(serial, 'error');
        }
      } else {
        handleProviderResult(serial, result, false);
      }
      if (speech.active && speech.active.serial === serial) scheduleFrame();
    }

    function startBrowserSentence(sentence, owner) {
      var utterance;
      try {
        utterance = new SpeechSynthesisUtterance(sentence.text);
        utterance.rate = speechRate(owner, sentenceSpeechMetadata(sentence, owner));
        utterance.volume = voiceVolume;
        var voice = selectedVoice();
        if (voice) utterance.voice = voice;
      } catch (_) {
        status = 'speech-error';
        clearSpeechState();
        resolveSpeech(false);
        markSpeechDone(owner);
        setVoiceMode('captions', false);
        announceState();
        return;
      }

      var serial = ++speech.serial;
      speech.active = {
        serial: serial,
        backend: 'browser',
        owner: owner,
        utterance: utterance,
        providerMedia: null,
        providerCleanup: null,
        remaining: speechWatchdogMs(sentence, speechRate(owner, sentenceSpeechMetadata(sentence, owner))),
      };
      utterance.onend = function () { finishSpeechSentence(serial, 'end'); };
      utterance.onerror = function () { finishSpeechSentence(serial, 'error'); };

      try {
        speechSynthesis.speak(utterance);
      } catch (_) {
        finishSpeechSentence(serial, 'error');
        return;
      }
      if (!speech.active || speech.active.serial !== serial) return;
      setVoiceMode('browser', false);
      status = 'speaking';
      announceState();
      scheduleFrame();
    }

    function startSpeechSentence() {
      var owner = speech.owner;
      var sentence = speech.queue[speech.cursor];
      if (!sentence || destroyed) {
        markSpeechDone(owner);
        clearSpeechState();
        resolveSpeech(false);
        return;
      }

      showCaption(owner, speech.cursor);
      if (destroyed || !voiceEnabled || (owner && (transition !== owner || owner.epoch !== callbackToken))) {
        markSpeechDone(owner);
        clearSpeechState();
        resolveSpeech(false);
        return;
      }
      if (!providerAvailable() && !speechAvailable()) {
        setVoiceMode('captions', false);
        status = 'speech-unavailable';
        markSpeechDone(owner);
        clearSpeechState();
        resolveSpeech(false);
        announceState();
        return;
      }

      if (providerAvailable() && !speech.fallbackToBrowser) startProviderSentence(sentence, owner);
      else startBrowserSentence(sentence, owner);
    }

    function startSpeechQueue(queue, owner, resolver, metadata) {
      if (!queue.length) {
        markSpeechDone(owner);
        if (typeof resolver === 'function') resolver(true);
        return safePromise(true);
      }
      cancelSpeech();
      speech.queue = queue;
      speech.cursor = 0;
      speech.owner = owner || null;
      speech.resolver = typeof resolver === 'function' ? resolver : null;
      speech.settled = false;
      speech.metadata = copyValue(metadata, 0);
      speech.fallbackToBrowser = false;
      speech.serial += 1;
      startSpeechSentence();
      return null;
    }

    function beginStepSpeech(owner) {
      if (!owner || owner.speechDone || owner.speechStarted || !owner.speechPending) return;
      if (destroyed || transition !== owner || owner.epoch !== callbackToken || !voiceEnabled) {
        owner.speechDone = true;
        owner.speechPending = false;
        return;
      }
      owner.speechPending = false;
      owner.speechStarted = true;
      startSpeechQueue(owner.narration, owner, null, owner.metadata);
    }

    function startStepSpeech(owner) {
      if (!owner || owner.narrationStarted) return;
      owner.narrationStarted = true;
      if (!owner.narration.length) {
        owner.speechDone = true;
        owner.speechLeadInDone = true;
        return;
      }
      showCaption(owner, 0);
      if (destroyed || transition !== owner || owner.epoch !== callbackToken) return;
      if (!voiceEnabled) {
        owner.speechDone = true;
        owner.speechLeadInDone = true;
        return;
      }
      owner.speechDone = false;
      owner.speechPending = true;
      owner.speechStarted = false;
      owner.speechLeadInElapsed = 0;
      owner.speechLeadInDone = speechLeadInMs <= 0;
      if (owner.speechLeadInDone) beginStepSpeech(owner);
    }

    function invalidate() {
      callbackToken += 1;
      cancelSpeech();
      cleanAnimations();
      transition = null;
      cancelFrame();
    }

    function numericChange(step) {
      if (!step || typeof step !== 'object') return null;
      var before = step.before;
      var after = step.after;
      var target = step.target;
      if (target && typeof target === 'object') {
        if (before == null) before = objectValue(target, ['before', 'from', 'old']);
        if (after == null) after = objectValue(target, ['after', 'to', 'new', 'value']);
      }
      var change = step.change;
      if (change && typeof change === 'object') {
        if (before == null) before = objectValue(change, ['before', 'from', 'old']);
        if (after == null) after = objectValue(change, ['after', 'to', 'new']);
      }
      var beforeNumber = Number(before);
      var afterNumber = Number(after);
      if (!finiteNumber(beforeNumber) || !finiteNumber(afterNumber)) return null;
      if (afterNumber > beforeNumber) return 'up';
      if (afterNumber < beforeNumber) return 'down';
      return null;
    }

    function effectKind(step, direction) {
      if (!step || typeof step !== 'object') return direction < 0 ? 'down' : 'tick';
      var eventType = asLower(objectValue(step, ['eventType', 'event', 'type', 'kind']));
      if (step.error || /error|exception|fail|invalid/.test(eventType)) return 'error';
      if (step.found === true || /success|answer-found|match/.test(eventType)) return 'success';
      if (/loop-(?:end|exit)|\bbreak\b|return|complete|finished/.test(eventType)) return 'exit-chime';
      if (/loop|condition|branch|check/.test(eventType)) {
        return numericChange(step) || 'loop-click';
      }
      var change = numericChange(step);
      if (change) return change;
      if (/output|print|append|push|insert|assign|set|store|update|write|create|add/.test(eventType)) return 'pop';
      if (direction < 0) return 'down';
      return 'tick';
    }

    function audioConstructor() {
      try {
        return host.AudioContext || host.webkitAudioContext || (host.window && (host.window.AudioContext || host.window.webkitAudioContext));
      } catch (_) {
        return null;
      }
    }

    function ensureAudioContext() {
      if (!audioUnlocked || destroyed || audioUnavailable) return null;
      if (audioContext) return audioContext;
      var Constructor = audioConstructor();
      if (typeof Constructor !== 'function') {
        audioUnavailable = true;
        return null;
      }
      try {
        audioContext = new Constructor();
      } catch (_) {
        audioUnavailable = true;
        audioContext = null;
      }
      return audioContext;
    }

    function unlock() {
      if (destroyed) return safePromise(false);
      audioUnlocked = true;
      var context = ensureAudioContext();
      if (!context || typeof context.resume !== 'function') return safePromise(!!context);
      var resumed;
      try { resumed = context.resume(); } catch (_) { resumed = null; }
      if (resumed && typeof resumed.then === 'function') {
        return resumed.then(function () { return true; }, function () { return false; });
      }
      return safePromise(true);
    }

    function effectSpec(kind) {
      var specs = {
        tick: { type: 'triangle', start: 480, end: 540, duration: 0.055 },
        pop: { type: 'triangle', start: 620, end: 820, duration: 0.12 },
        up: { type: 'sine', start: 500, end: 900, duration: 0.14 },
        down: { type: 'sine', start: 520, end: 260, duration: 0.14 },
        'loop-click': { type: 'square', start: 350, end: 350, duration: 0.065 },
        'exit-chime': { type: 'sine', start: 720, end: 1040, duration: 0.24 },
        success: { type: 'triangle', start: 660, end: 990, duration: 0.28 },
        error: { type: 'sawtooth', start: 190, end: 105, duration: 0.18 },
      };
      return specs[kind] || specs.tick;
    }

    function playEffect(kind) {
      if (!audioUnlocked || effectsMuted || effectsVolume <= 0) return;
      var context = ensureAudioContext();
      if (!context || typeof context.createOscillator !== 'function' || typeof context.createGain !== 'function') return;
      var spec = effectSpec(kind);
      var oscillator;
      var gain;
      try {
        oscillator = context.createOscillator();
        gain = context.createGain();
        var now = finiteNumber(Number(context.currentTime)) ? Number(context.currentTime) : 0;
        var end = now + spec.duration;
        oscillator.type = spec.type;
        if (oscillator.frequency && typeof oscillator.frequency.setValueAtTime === 'function') {
          oscillator.frequency.setValueAtTime(spec.start, now);
          if (typeof oscillator.frequency.exponentialRampToValueAtTime === 'function' && spec.end > 0) oscillator.frequency.exponentialRampToValueAtTime(spec.end, end);
          else if (typeof oscillator.frequency.linearRampToValueAtTime === 'function') oscillator.frequency.linearRampToValueAtTime(spec.end, end);
        }
        var peak = Math.max(0.001, Math.min(0.22, effectsVolume * 0.22));
        if (gain.gain && typeof gain.gain.setValueAtTime === 'function') {
          gain.gain.setValueAtTime(peak, now);
          if (typeof gain.gain.exponentialRampToValueAtTime === 'function') gain.gain.exponentialRampToValueAtTime(0.001, end);
          else if (typeof gain.gain.linearRampToValueAtTime === 'function') gain.gain.linearRampToValueAtTime(0.001, end);
        }
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(now);
        oscillator.stop(end);
      } catch (_) {
        try { if (oscillator && typeof oscillator.stop === 'function') oscillator.stop(); } catch (_) {}
      }
    }

    function emitEffect(step, direction, explicitKind) {
      var kind = explicitKind || effectKind(step, direction);
      safeCall(onEffectVisual, [kind]);
      playEffect(kind);
    }

    function enterStep(index, enterOptions) {
      enterOptions = enterOptions || {};
      cleanAnimations();
      transition = null;
      currentIndex = clampIndex(index, steps.length);
      var epoch = callbackToken;
      var animated = enterOptions.animated !== false;
      var animations = [];
      var metadata = stepMetadata(currentIndex, enterOptions.metadata);
      var result = safeCall(onStep, [currentIndex, { animated: animated, direction: enterOptions.direction || 0, metadata: copyValue(metadata, 0) }]);
      if (Array.isArray(result)) animations = result.filter(prepareAnimation);
      var actualMotionDuration = 0;
      animations.forEach(function (animation) { actualMotionDuration = Math.max(actualMotionDuration, animationDuration(animation)); });
      var motionDuration = animations.length ? Math.max(DEFAULT_MOTION_DURATION, actualMotionDuration) : 0;
      var narration = normalizeNarration(currentIndex);
      var shouldClock = enterOptions.clockDwell !== false;

      if (animated) animations.forEach(function (animation) { setAnimationTime(animation, 0); });
      else animations.forEach(function (animation) { setAnimationTime(animation, animationDuration(animation)); });

      if (shouldClock) {
        transition = {
          epoch: epoch,
          index: currentIndex,
          animations: animations,
          narration: narration,
          captionCursor: -1,
          narrationStarted: false,
          speechRequested: !!enterOptions.speak,
          speechDone: !enterOptions.speak,
          speechPending: false,
          speechStarted: false,
          speechLeadInElapsed: 0,
          speechLeadInDone: !enterOptions.speak || speechLeadInMs <= 0,
          metadata: metadata,
          elapsed: 0,
          motionDuration: animated ? motionDuration : 0,
          motionDone: !animated || motionDuration <= 0,
          dwellDone: false,
          pauseDone: currentIndex >= steps.length - 1 || pauseBetweenStepsMs <= 0,
         };
        if (narration.length) showCaption(transition, 0);
        if (enterOptions.speak) startStepSpeech(transition);
        if (!animated) {
          cleanAnimations();
          transition.animations = [];
        }
      } else {
        var staticOwner = { narration: narration, captionCursor: -1 };
        if (narration.length) showCaption(staticOwner, 0);
        animations.forEach(cancelAnimation);
      }

      if (enterOptions.emitEffect !== false) emitEffect(steps[currentIndex], enterOptions.direction || 0);
      if (shouldClock) scheduleFrame();
      return transition;
    }

    function finishPausedTransition() {
      if (!transition || playing) return;
      if (!transition.motionDone || !transition.dwellDone || !transition.pauseDone || !transition.speechLeadInDone || !transition.speechDone) return;
      cleanAnimations();
      transition = null;
      if (status === 'speaking') status = 'paused';
    }

    function completePlayback() {
      if (!playing) return;
      cleanAnimations();
      transition = null;
      playing = false;
      emitEffect(steps[currentIndex], 0, steps[currentIndex] && steps[currentIndex].found ? 'success' : 'exit-chime');
      cancelFrame();
      status = 'complete';
      announceState();
    }

    function advanceIfReady() {
      if (!playing || !transition || transition.epoch !== callbackToken || transition.index !== currentIndex) return;
      if (!transition.motionDone || !transition.dwellDone || !transition.pauseDone || !transition.speechLeadInDone || !transition.speechDone) return;
      if (currentIndex >= steps.length - 1) {
        completePlayback();
        return;
      }
      var nextIndex = currentIndex + 1;
      enterStep(nextIndex, { animated: true, direction: 1, speak: voiceEnabled, emitEffect: true });
      status = voiceEnabled && speech.active ? 'speaking' : 'playing';
      announceState();
    }

    function updateTransition(delta) {
      if (!transition) return;
      var scaled = delta * speed;
      transition.elapsed += scaled;
      if (transition.animations.length) {
        var progress = transition.motionDuration > 0 ? Math.min(1, transition.elapsed / transition.motionDuration) : 1;
        transition.animations.forEach(function (animation) {
          setAnimationTime(animation, animationDuration(animation) * progress);
        });
      }
      transition.motionDone = transition.elapsed >= transition.motionDuration;
      transition.dwellDone = transition.elapsed >= durationMs;
      transition.pauseDone = transition.index >= steps.length - 1 || transition.elapsed >= durationMs + pauseBetweenStepsMs;
      if (transition.speechRequested && !transition.speechLeadInDone) {
        transition.speechLeadInElapsed += scaled;
        if (transition.speechLeadInElapsed >= speechLeadInMs) {
          transition.speechLeadInDone = true;
          beginStepSpeech(transition);
        }
      }
      if (!playing) finishPausedTransition();
      else advanceIfReady();
    }

    function updateSpeechWatchdog(delta) {
      if (!speech.active || !finiteNumber(delta) || delta < 0) return;
      speech.active.remaining -= delta;
      if (speech.active.remaining <= 0) finishSpeechSentence(speech.active.serial, 'timeout');
    }

    function tick(timestamp) {
      if (destroyed) return;
      var now = Number(timestamp);
      if (!finiteNumber(now)) now = getNow();
      if (previousFrameTime === null) previousFrameTime = now;
      var delta = now - previousFrameTime;
      previousFrameTime = now;
      if (!finiteNumber(delta) || delta < 0) delta = 0;
      if (documentRef && documentRef.hidden) {
        if (shouldRunClock()) pause();
        return;
      }
      updateSpeechWatchdog(delta);
      updateTransition(delta);
      if (transition && !playing) finishPausedTransition();
      if (shouldRunClock()) scheduleFrame();
    }

    function load(nextSteps) {
      if (destroyed) return api;
      invalidate();
      steps = Array.isArray(nextSteps) ? nextSteps.slice() : [];
      currentIndex = 0;
      playing = false;
      status = steps.length ? 'ready' : 'empty';
      if (steps.length) enterStep(0, { animated: false, direction: 0, speak: false, clockDwell: false, emitEffect: true });
      announceState();
      return api;
    }

    function play() {
      if (destroyed || !steps.length || !visible) return api;
      if (playing) return api;

      playing = true;
      if (!transition || transition.index !== currentIndex) {
        enterStep(currentIndex, { animated: false, direction: 0, speak: voiceEnabled, emitEffect: false });
      } else if (voiceEnabled && !transition.narrationStarted) {
        startStepSpeech(transition);
      }
      status = voiceEnabled && speech.active ? 'speaking' : 'playing';
      announceState();
      scheduleFrame();
      return api;
    }

    function pause() {
      if (destroyed) return api;
      playing = false;
      invalidate();
      status = 'paused';
      announceState();
      return api;
    }

    function seek(index, seekOptions) {
      if (destroyed || !steps.length) return api;
      seekOptions = seekOptions && typeof seekOptions === 'object' ? seekOptions : {};
      var oldIndex = currentIndex;
      var wasPlaying = playing;
      var target = clampIndex(index, steps.length);
      var animated = seekOptions.animate !== false;
      var speakRequested = seekOptions.speak === true;
      invalidate();
      playing = wasPlaying;
      currentIndex = target;
      status = playing ? 'playing' : 'paused';
      enterStep(target, {
        animated: animated,
        direction: target === oldIndex ? 0 : target > oldIndex ? 1 : -1,
        speak: speakRequested,
        emitEffect: true,
      });
      if (playing) scheduleFrame();
      else if (transition) scheduleFrame();
      announceState();
      return api;
    }

    function next() {
      if (destroyed || !steps.length) return api;
      if (currentIndex >= steps.length - 1) {
        playing = false;
        invalidate();
        status = 'complete';
        emitEffect(steps[currentIndex], 0, 'exit-chime');
        announceState();
        return api;
      }
      var wasPlaying = playing;
      var target = currentIndex + 1;
      invalidate();
      playing = wasPlaying;
      status = playing ? 'playing' : 'paused';
      enterStep(target, { animated: true, direction: 1, speak: voiceEnabled, emitEffect: true });
      if (playing || transition) scheduleFrame();
      announceState();
      return api;
    }

    function previous() {
      if (destroyed || !steps.length) return api;
      var wasPlaying = playing;
      var target = Math.max(0, currentIndex - 1);
      invalidate();
      playing = wasPlaying;
      status = playing ? 'playing' : 'paused';
      enterStep(target, { animated: true, direction: target === currentIndex ? 0 : -1, speak: voiceEnabled, emitEffect: true });
      if (playing || transition) scheduleFrame();
      announceState();
      return api;
    }

    function repeat() {
      if (destroyed || !steps.length) return api;
      var wasPlaying = playing;
      invalidate();
      playing = wasPlaying;
      status = playing ? 'playing' : 'paused';
      enterStep(currentIndex, { animated: true, direction: 0, speak: voiceEnabled, emitEffect: true });
      if (playing || transition) scheduleFrame();
      announceState();
      return api;
    }

    function speak(value, metadata) {
      var sentenceText = text(value);
      if (!sentenceText) return safePromise(false);
      var token = callbackToken;
      safeCall(onCaption, [sentenceText, null]);
      if (destroyed || token !== callbackToken) return safePromise(false);
      if (!voiceEnabled || (!providerAvailable() && !speechAvailable())) {
        if (voiceEnabled && !providerAvailable() && !speechAvailable()) {
          setVoiceMode('captions', false);
          status = 'speech-unavailable';
          announceState();
        }
        return safePromise(false);
      }
      return new Promise(function (resolve) {
        startSpeechQueue([{ text: sentenceText, field: null }], null, resolve, metadata);
        scheduleFrame();
      });
    }

    function setSpeed(value) {
      if (destroyed) return api;
      speed = clamp(value, MIN_SPEED, MAX_SPEED, speed);
      if (speech.active && speech.active.utterance) {
        var activeSentence = speech.queue[speech.cursor];
        try { speech.active.utterance.rate = speechRate(speech.active.owner, sentenceSpeechMetadata(activeSentence, speech.active.owner)); } catch (_) {}
      }
      announceState();
      return api;
    }

    function setPauseBetweenSteps(value) {
      if (destroyed) return api;
      pauseBetweenStepsMs = clamp(value, 0, 120000, pauseBetweenStepsMs);
      announceState();
      if (shouldRunClock()) scheduleFrame();
      return api;
    }

    function setSpeechLeadIn(value) {
      if (destroyed) return api;
      speechLeadInMs = clamp(value, 0, 120000, speechLeadInMs);
      if (transition && transition.speechPending) {
        transition.speechLeadInDone = transition.speechLeadInElapsed >= speechLeadInMs;
        if (transition.speechLeadInDone) beginStepSpeech(transition);
      }
      announceState();
      if (shouldRunClock()) scheduleFrame();
      return api;
    }

    function setVoice(uri) {
      if (destroyed) return api;
      selectedVoiceUri = uri == null ? null : text(uri);
      return api;
    }

    function setVoiceEnabled(enabled) {
      if (destroyed) return api;
      var nextValue = !!enabled;
      if (nextValue === voiceEnabled) {
        announceState();
        return api;
      }
      voiceEnabled = nextValue;
      if (!voiceEnabled) {
        if (transition) {
          transition.speechDone = true;
          transition.narrationStarted = false;
          transition.speechRequested = false;
          transition.speechPending = false;
          transition.speechStarted = false;
          transition.speechLeadInDone = true;
          transition.captionCursor = -1;
        }
        cancelSpeech();
        status = playing ? 'playing' : 'paused';
      } else if (transition && !transition.narrationStarted) {
        transition.speechRequested = true;
        startStepSpeech(transition);
        status = speech.active ? 'speaking' : status;
      }
      setVoiceMode(preferredVoiceMode(), false);
      announceState();
      if (shouldRunClock()) scheduleFrame();
      return api;
    }

    function setVoiceProviderEnabled(enabled) {
      if (destroyed) return api;
      voiceProviderEnabled = !!enabled;
      if (!voiceProviderEnabled && speech.active && speech.active.backend === 'provider') {
        var activeOwner = speech.active.owner;
        var activeCursor = speech.cursor;
        var activeQueue = speech.queue;
        var activeMetadata = speech.metadata;
        cancelSpeech();
        if (activeQueue.length && validSpeechOwner(activeOwner) && voiceEnabled) {
          speech.queue = activeQueue;
          speech.cursor = activeCursor;
          speech.owner = activeOwner;
          speech.metadata = activeMetadata;
          speech.resolver = null;
          speech.settled = false;
          speech.fallbackToBrowser = true;
          if (activeOwner) {
            activeOwner.speechDone = false;
            activeOwner.speechStarted = true;
            activeOwner.speechPending = false;
          }
          startSpeechSentence();
        }
      }
      setVoiceMode(preferredVoiceMode(), false);
      announceState();
      if (shouldRunClock()) scheduleFrame();
      return api;
    }

    function setVoiceVolume(value) {
      if (destroyed) return api;
      voiceVolume = clamp(value, 0, 1, voiceVolume);
      if (speech.active && speech.active.utterance) {
        try { speech.active.utterance.volume = voiceVolume; } catch (_) {}
      }
      announceState();
      return api;
    }

    function setEffectsMuted(muted) {
      if (destroyed) return api;
      effectsMuted = !!muted;
      announceState();
      return api;
    }

    function setEffectsVolume(value) {
      if (destroyed) return api;
      effectsVolume = clamp(value, 0, 1, effectsVolume);
      announceState();
      return api;
    }

    function handleVisibility() {
      visible = !(documentRef && documentRef.hidden);
      if (!visible && shouldRunClock()) pause();
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      playing = false;
      callbackToken += 1;
      cancelSpeech();
      cleanAnimations();
      transition = null;
      cancelFrame();
      if (documentRef && typeof documentRef.removeEventListener === 'function' && visibilityHandler) {
        try { documentRef.removeEventListener('visibilitychange', visibilityHandler); } catch (_) {}
      }
      if (audioContext && typeof audioContext.close === 'function') {
        try {
          var closed = audioContext.close();
          if (closed && typeof closed.catch === 'function') closed.catch(noop);
        } catch (_) {}
      }
      audioContext = null;
    }

    var visibilityHandler = handleVisibility;
    if (documentRef) {
      try { visible = !documentRef.hidden; } catch (_) { visible = true; }
      if (typeof documentRef.addEventListener === 'function') {
        try { documentRef.addEventListener('visibilitychange', visibilityHandler); } catch (_) {}
      }
    }

    api = {
      load: load,
      play: play,
      pause: pause,
      seek: seek,
      next: next,
      previous: previous,
      repeat: repeat,
      speak: speak,
      setSpeed: setSpeed,
      setPauseBetweenSteps: setPauseBetweenSteps,
      setSpeechLeadIn: setSpeechLeadIn,
      setVoice: setVoice,
      setVoiceEnabled: setVoiceEnabled,
      setVoiceProviderEnabled: setVoiceProviderEnabled,
      setVoiceVolume: setVoiceVolume,
      setEffectsMuted: setEffectsMuted,
      setEffectsVolume: setEffectsVolume,
      unlock: unlock,
      voices: voiceList,
      destroy: destroy,
    };

    Object.defineProperty(api, 'isPlaying', {
      enumerable: true,
      configurable: false,
      get: function () { return playing; },
    });

    announceState();
    return api;
  }

  root.CodeFlowPlayer = { create: create };
}(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this));
