(function () {
  'use strict';

  const state = { live: null, model: null, busy: false, generation: 0, pollTimer: null, fullPollTimer: null, token: null, user: null, config: null, active: false, reading: false, reads: new Set(), expiryTimer: null, recovery: false, panels: {}, received: null, stateStale: false, soundEnabled: false, userMuted: false, audioError: null, audioContext: null, audioResumePromise: null, alarmStatus: 'Unknown', alarmPlaybackTimer: null, alarmPlaybackToken: 0, alarmPlaybackActive: false, alarmPlaybackStarting: false, alarmNodes: new Set() };
  let authorityClinics = []; let authorityClinicId = null;
  const $ = (id) => document.getElementById(id);
  const els = {
    loading: $('loadingState'), error: $('globalError'), errorTitle: $('errorTitle'), errorMessage: $('errorMessage'),
    simClock: $('simClock'), horizon: $('horizonValue'), lastSync: $('lastSync'), feederGrid: $('feederGrid'),
    feederSelect: $('feederSelect'), clinicSelect: $('clinicSelect'), feederFilter: $('feederFilter'), riskFilter: $('riskFilter'), search: $('clinicSearch'),
    tableBody: $('clinicTableBody'), tableSummary: $('tableSummary'), modelStatus: $('modelStatus'), modelUnavailable: $('modelUnavailable'), modelContent: $('modelContent'), thermalForecastValidation: $('thermalForecastValidation'), thermalValidationText: $('thermalValidationText'), powerCutForecastPanel: $('powerCutForecast'), powerCutForecastStatus: $('powerCutForecastStatus'), powerCutForecastClinic: $('powerCutForecastClinic'), powerCutCurrentTemp: $('powerCutCurrentTemp'), powerCutAmbientTemp: $('powerCutAmbientTemp'), powerCutSafeRange: $('powerCutSafeRange'), powerCutLimit: $('powerCutLimit'), powerCutAfter1h: $('powerCutAfter1h'), powerCutAfter2h: $('powerCutAfter2h'), powerCutAfter6h: $('powerCutAfter6h'), powerCutTimeToLimit: $('powerCutTimeToLimit'), powerCutForecastNote: $('powerCutForecastNote'), powerCutChart: $('powerCutForecastChart'), powerCutChartNote: $('powerCutChartNote'), temperatureAlarmPanel: $('temperatureAlarmPanel'), temperatureAlarmStatus: $('temperatureAlarmStatus'), temperatureAlarmThreshold: $('temperatureAlarmThreshold'), temperatureAlarmCount: $('temperatureAlarmCount'), temperatureAlarmCountLabel: $('temperatureAlarmCountLabel'), temperatureAlarmLastRefresh: $('temperatureAlarmLastRefresh'), alarmSoundButton: $('alarmSoundButton'), alarmSoundStatus: $('alarmSoundStatus'), authoritySection: $('authoritySection'), authorityNav: $('authorityNav'), authorityClinicBody: $('authorityClinicBody'), authorityClinicDetail: $('authorityClinicDetail'), authorityDetailTitle: $('authorityDetailTitle'), authorityDetailContent: $('authorityDetailContent'), authorityFollowupForm: $('authorityFollowupForm'), authorityFollowupMessage: $('authorityFollowupMessage'), authorityFollowupStatus: $('authorityFollowupStatus'), authorityFollowupList: $('authorityFollowupList')
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }

  function formatNumber(value, digits) {
    return finite(value) ? Number(value).toFixed(digits == null ? 0 : digits) : 'Unavailable';
  }

  function percent(value, digits) {
    return finite(value) ? `${(Number(value) * 100).toFixed(digits == null ? 0 : digits)}%` : 'Unavailable / rules only';
  }

  function localTime(iso) {
    if (!iso) return '—';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function showError(title, message) {
    els.errorTitle.textContent = title;
    els.errorMessage.textContent = message;
    els.error.hidden = false;
  }

  function hideError() { els.error.hidden = true; }

  const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  const text = (value) => value == null ? 'Unavailable' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const role = () => state.user && state.user.role;
  const permitted = (kind) => ({ feeder: ['admin', 'authority', 'grid_operator'], clinic: ['admin', 'authority', 'clinic_operator'], feedback: ['admin', 'authority', 'clinic_operator'], audit: ['admin', 'authority', 'auditor'], write: ['admin', 'authority', 'clinic_operator', 'grid_operator'] }[kind] || []).includes(role());
  const authorityEnabled = () => ['admin', 'authority'].includes(role());
  const riskClass = (value) => ({ safe: 'safe', healthy: 'safe', critical: 'critical', high: 'critical', warning: 'warning', medium: 'warning', low: 'safe' }[String(value).toLowerCase()] || 'unknown');
  const SMS_STATE_LABELS = { normal: 'Normal', critical_no_sms: 'Critical · no backup', critical_unconfirmed: 'Critical · awaiting reply', needs_help: 'Needs help', backup_in_use: 'Backup in use', backup_exhausted: 'Backup exhausted' };
  const SMS_STATE_CLASSES = { normal: 'safe', critical_no_sms: 'critical', critical_unconfirmed: 'warning', needs_help: 'critical', backup_in_use: 'safe', backup_exhausted: 'critical' };
  const smsStateLabel = (value) => SMS_STATE_LABELS[String(value)] || 'Unknown';
  const smsStateClass = (value) => SMS_STATE_CLASSES[String(value)] || 'unknown';
  const THERMAL_ALARM_THRESHOLD = 6;
  const ALARM_FIELDS = ['temperature_alarm', 'temperature_alarm_active', 'thermal_alarm', 'thermal_alarm_active', 'critical_thermal_alarm', 'alarm_active', 'temperature_alarm_status', 'thermal_alarm_status', 'alarm_state'];
  const alarmText = (value) => String(value == null ? '' : value).toLowerCase().replace(/[_-]+/g, ' ');
  function freshReading(clinic) {
    if (!clinic || state.stateStale) return false;
    if (clinic.stale === true || clinic.is_stale === true || clinic.reading_stale === true) return false;
    const quality = alarmText(clinic.data_quality || clinic.quality || clinic.telemetry_quality);
    return !/(stale|missing|unknown|unavailable|invalid)/.test(quality);
  }
  function interpretAlarmValue(value, field) {
    const name = alarmText(field);
    if (typeof value === 'boolean') return { present: true, active: value, critical: value && name.includes('critical'), label: value ? (name.includes('critical') ? 'Critical thermal alarm' : 'Temperature alarm') : '' };
    if (typeof value === 'number') return { present: true, active: value > 0, critical: value > 0 && name.includes('critical'), label: value > 0 ? 'Temperature alarm' : '' };
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const activeValue = ['active', 'alarm_active', 'triggered', 'is_active', 'open'].find((key) => Object.prototype.hasOwnProperty.call(value, key));
      const statusValue = value.status ?? value.state ?? value.severity ?? value.level;
      const status = alarmText(statusValue);
      const active = activeValue ? interpretAlarmValue(value[activeValue], activeValue).active : status ? !/(clear|normal|safe|resolved|closed|inactive|none|ok|false)/.test(status) : Object.keys(value).length > 0;
      const critical = name.includes('critical') || /critical/.test(status) || alarmText(value.severity).includes('critical');
      return { present: true, active, critical: active && critical, label: active ? (critical ? 'Critical thermal alarm' : 'Temperature alarm') : '' };
    }
    if (Array.isArray(value)) return { present: true, active: value.length > 0, critical: value.some((item) => /critical/.test(alarmText(item && (item.severity || item.level || item.status)))), label: value.length ? 'Temperature alarm' : '' };
    const status = alarmText(value);
    if (!status) return { present: true, active: false, critical: false, label: '' };
    const active = !/(clear|normal|safe|resolved|closed|inactive|none|ok|false|off)/.test(status);
    return { present: true, active, critical: active && (name.includes('critical') || /critical/.test(status)), label: active ? (/critical/.test(status) ? 'Critical thermal alarm' : 'Temperature alarm') : '' };
  }
  function alarmFromCollection(data, clinic) {
    const collections = [data && data.temperature_alarms, data && data.thermal_alarms, data && data.alarms].filter(Array.isArray);
    for (const collection of collections) {
      const match = collection.find((item) => {
        const entity = item && (item.clinic_id ?? item.entity_id ?? item.id);
        const kind = alarmText(item && (item.kind || item.type || item.category || item.alert_type || item.message));
        return String(entity) === String(clinic.id) && /thermal|temperature/.test(kind);
      });
      if (match) return interpretAlarmValue(match, match.kind || match.type || 'thermal_alarm');
    }
    return null;
  }
  function formatAlarmThreshold(value) {
    const number = finite(value) ? Number(value) : THERMAL_ALARM_THRESHOLD;
    return Number.isInteger(number) ? String(number) : number.toFixed(1);
  }
  function temperatureAlarm(clinic, data) {
    const threshold = finite(clinic && clinic.temperature_alarm_threshold_c) ? Number(clinic.temperature_alarm_threshold_c) : finite(data && data.temperature_alarm_threshold_c) ? Number(data.temperature_alarm_threshold_c) : THERMAL_ALARM_THRESHOLD;
    let backendAlarm = null;
    for (const field of ALARM_FIELDS) {
      if (clinic && Object.prototype.hasOwnProperty.call(clinic, field)) {
        backendAlarm = interpretAlarmValue(clinic[field], field);
        if (field === 'temperature_alarm' && backendAlarm.active && alarmText(clinic.temperature_alarm_level).includes('critical')) {
          backendAlarm.critical = true; backendAlarm.label = 'Critical thermal alarm';
        }
        break;
      }
    }
    if (!backendAlarm) backendAlarm = alarmFromCollection(data, clinic);
    if (!backendAlarm) {
      const fallbackActive = finite(clinic && clinic.temperature_c) && Number(clinic.temperature_c) > threshold;
      const critical = fallbackActive && String(clinic && clinic.risk_level).toLowerCase() === 'critical';
      backendAlarm = { present: false, active: fallbackActive, critical, label: fallbackActive ? (critical ? 'Critical thermal alarm' : 'Temperature alarm') : '' };
    }
    const detected = backendAlarm.active === true;
    return { detected, active: detected && freshReading(clinic), stale: detected && !freshReading(clinic), critical: detected && backendAlarm.critical === true, threshold, label: backendAlarm.label || (backendAlarm.critical ? 'Critical thermal alarm' : 'Temperature alarm') };
  }
  function alarmLevel(status) {
    const normalized = alarmText(status);
    if (/critical/.test(normalized)) return 'Critical';
    if (/warning/.test(normalized)) return 'Warning';
    if (/normal|safe|healthy/.test(normalized)) return 'Safe';
    return 'Unknown';
  }
  function isAlertLevel(level) { return level === 'Warning' || level === 'Critical'; }
  function renderAlarmSoundStatus() {
    if (!els.alarmSoundStatus) return;
    const level = state.alarmStatus;
    if (state.audioError && isAlertLevel(level)) {
      els.alarmSoundStatus.textContent = `${state.audioError} Visual alarm remains active.`;
    } else if (state.audioError) {
      els.alarmSoundStatus.textContent = `${state.audioError} Click Enable alarm sound to retry.`;
    } else if (isAlertLevel(level) && state.soundEnabled && state.alarmPlaybackActive) {
      els.alarmSoundStatus.textContent = `Alarm sounding automatically · system status ${level}.`;
    } else if (isAlertLevel(level) && state.soundEnabled && state.alarmPlaybackStarting) {
      els.alarmSoundStatus.textContent = `System status ${level} · starting alarm sound…`;
    } else if (isAlertLevel(level) && state.userMuted) {
      els.alarmSoundStatus.textContent = `Alarm muted · system status ${level} is still being monitored.`;
    } else if (isAlertLevel(level)) {
      els.alarmSoundStatus.textContent = `System status ${level} · click Enable alarm sound to permit playback.`;
    } else if (state.soundEnabled) {
      els.alarmSoundStatus.textContent = 'Sound enabled · new WARNING/CRITICAL statuses will sound automatically.';
    } else {
      els.alarmSoundStatus.textContent = 'Sound is muted until enabled by a user click.';
    }
  }
  function updateAlarmSoundButton() {
    if (!els.alarmSoundButton) return;
    els.alarmSoundButton.textContent = state.soundEnabled ? 'Mute alarm sound' : 'Enable alarm sound';
    els.alarmSoundButton.setAttribute('aria-pressed', state.soundEnabled ? 'true' : 'false');
    renderAlarmSoundStatus();
  }
  function prepareAudioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    try {
      if (!state.audioContext || state.audioContext.state === 'closed') state.audioContext = new AudioContextClass();
      const context = state.audioContext;
      if (['suspended', 'interrupted'].includes(context.state) && context.resume) {
        if (!state.audioResumePromise) {
          state.audioResumePromise = Promise.resolve(context.resume()).finally(() => { state.audioResumePromise = null; });
        }
      }
      return context;
    } catch (_) {
      return null;
    }
  }
  function stopAlarmSound() {
    if (state.alarmPlaybackTimer !== null) { clearTimeout(state.alarmPlaybackTimer); state.alarmPlaybackTimer = null; }
    state.alarmPlaybackToken += 1;
    state.alarmPlaybackActive = false;
    state.alarmPlaybackStarting = false;
    state.alarmNodes.forEach((node) => {
      try { if (typeof node.stop === 'function') node.stop(); } catch (_) {}
      try { if (typeof node.disconnect === 'function') node.disconnect(); } catch (_) {}
    });
    state.alarmNodes.clear();
  }
  function disposeAlarmAudio() {
    stopAlarmSound();
    if (state.audioContext && typeof state.audioContext.close === 'function') {
      try { state.audioContext.close(); } catch (_) {}
    }
    state.audioContext = null;
    state.audioResumePromise = null;
  }
  function failAlarmPlayback(message) {
    stopAlarmSound();
    state.soundEnabled = false;
    state.userMuted = false;
    state.audioError = message;
    updateAlarmSoundButton();
  }
  function playAlarmDoubleBeep() {
    if (!state.soundEnabled || !state.audioContext || ['suspended', 'interrupted', 'closed'].includes(state.audioContext.state)) return false;
    const context = state.audioContext;
    try {
      const start = context.currentTime + 0.01;
      [0, 0.2].forEach((offset) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(880, start + offset);
        gain.gain.setValueAtTime(0.0001, start + offset); gain.gain.exponentialRampToValueAtTime(0.16, start + offset + 0.015); gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.12);
        state.alarmNodes.add(oscillator); state.alarmNodes.add(gain);
        oscillator.onended = () => { state.alarmNodes.delete(oscillator); state.alarmNodes.delete(gain); };
        oscillator.connect(gain); gain.connect(context.destination); oscillator.start(start + offset); oscillator.stop(start + offset + 0.13);
      });
      return true;
    } catch (_) {
      // The visual alarm remains authoritative when Web Audio is unavailable.
      return false;
    }
  }
  function scheduleAlarmSound(token) {
    if (!state.alarmPlaybackActive || token !== state.alarmPlaybackToken || !isAlertLevel(state.alarmStatus) || !state.soundEnabled) return;
    state.alarmPlaybackTimer = setTimeout(() => {
      state.alarmPlaybackTimer = null;
      if (!state.alarmPlaybackActive || token !== state.alarmPlaybackToken || !isAlertLevel(state.alarmStatus) || !state.soundEnabled) return;
      if (!playAlarmDoubleBeep()) { failAlarmPlayback('Alarm sound could not be played.'); return; }
      scheduleAlarmSound(token);
    }, 1100);
  }
  function startAlarmSound() {
    if (!isAlertLevel(state.alarmStatus) || !state.soundEnabled) { renderAlarmSoundStatus(); return false; }
    if (state.alarmPlaybackActive || state.alarmPlaybackStarting) { renderAlarmSoundStatus(); return true; }
    const context = prepareAudioContext();
    if (!context) { failAlarmPlayback('Web Audio is unavailable;'); return false; }
    const token = ++state.alarmPlaybackToken;
    const begin = () => {
      state.alarmPlaybackStarting = false;
      if (token !== state.alarmPlaybackToken || !state.soundEnabled || !isAlertLevel(state.alarmStatus)) { renderAlarmSoundStatus(); return false; }
      if (['suspended', 'interrupted', 'closed'].includes(context.state)) { failAlarmPlayback('The browser blocked alarm playback. Click Enable alarm sound to retry.'); return false; }
      state.alarmPlaybackActive = true;
      if (!playAlarmDoubleBeep()) { failAlarmPlayback('Alarm sound could not be played.'); return false; }
      scheduleAlarmSound(token);
      renderAlarmSoundStatus();
      return true;
    };
    if (state.audioResumePromise) {
      state.alarmPlaybackStarting = true;
      renderAlarmSoundStatus();
      state.audioResumePromise.then(begin).catch(() => { if (token === state.alarmPlaybackToken) failAlarmPlayback('The browser blocked alarm playback. Click Enable alarm sound to retry.'); });
      return true;
    }
    return begin();
  }
  async function toggleAlarmSound() {
    if (state.soundEnabled) { state.soundEnabled = false; state.userMuted = true; state.audioError = null; stopAlarmSound(); updateAlarmSoundButton(); return; }
    state.userMuted = false; state.audioError = null;
    const context = prepareAudioContext();
    if (!context) { state.audioError = 'Web Audio is unavailable;'; updateAlarmSoundButton(); return; }
    try {
      if (state.audioResumePromise) await state.audioResumePromise;
      if (['suspended', 'interrupted', 'closed'].includes(context.state)) throw new Error('The browser kept audio suspended');
      state.soundEnabled = true; updateAlarmSoundButton();
      const played = playAlarmDoubleBeep();
      if (!played) throw new Error('The browser did not start the test beep');
      if (isAlertLevel(state.alarmStatus)) startAlarmSound();
      else els.alarmSoundStatus.textContent = 'Sound enabled · test beep played; new alarms will sound automatically.';
    } catch (_) {
      state.soundEnabled = false; state.audioError = 'Sound could not be enabled;'; stopAlarmSound(); updateAlarmSoundButton();
    }
  }
  function primeAlarmAudio() { if (!state.soundEnabled) prepareAudioContext(); }
  function validationMessage(detail) {
    if (Array.isArray(detail)) return detail.map((item) => `${Array.isArray(item.loc) ? item.loc.filter((part) => part !== 'body').join('.') + ': ' : ''}${text(item.msg || item.message || item)}`).join('; ');
    return text(detail);
  }
  async function api(path, options = {}) {
    const mutation = options.method && options.method !== 'GET';
    const controller = new AbortController();
    const generation = state.generation;
    if (!mutation) state.reads.add(controller);
    const timer = setTimeout(() => controller.abort(), mutation ? 25000 : 12000);
    try {
      const response = await fetch(path, { ...options, cache: 'no-store', signal: controller.signal, headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) } });
      let payload;
      try { payload = await response.json(); } catch (_) { if (response.ok) throw new Error('Server returned an invalid response.'); }
      if (!response.ok) {
        const error = new Error(payload ? validationMessage(payload.detail || payload.message || payload.error || `Request failed (${response.status})`) : `Request failed (${response.status})`);
        error.status = response.status;
        error.ambiguous = mutation && response.status >= 500;
        if (response.status === 401 && state.active && generation === state.generation) lockSession('Session expired or authorization was rejected. Sign in to continue.');
        throw error;
      }
      if (!payload || typeof payload !== 'object') throw new Error('Server returned no usable data.');
      return payload;
    } catch (error) {
      if (!error.status) { error.ambiguous = !!mutation; error.message = error.name === 'AbortError' ? 'Request timed out or was cancelled.' : error.message; }
      throw error;
    } finally { clearTimeout(timer); state.reads.delete(controller); }
  }

  function setControlsDisabled(disabled) {
    const locked = disabled || !state.active || state.recovery;
    document.querySelectorAll('[data-action-control]').forEach((control) => {
      const kind = ['tripFeeder', 'restoreFeeder', 'feederSelect'].includes(control.id) ? 'feeder' : ['localFault', 'restoreClinic', 'freezeClinic', 'clinicSelect'].includes(control.id) ? 'clinic' : 'write';
      const externalLocked = state.live && state.live.telemetry_mode === 'external' && control.id !== 'resetSimulation';
      control.disabled = locked || !permitted(kind) || !state.live || externalLocked;
      control.title = !permitted(kind) ? 'Your role has read-only access to this control.' : externalLocked ? 'External readings are active. Explicitly reset to return to the synthetic sandbox.' : '';
    });
    document.querySelectorAll('[data-ack]').forEach((control) => { control.disabled = locked || !permitted('write') || control.dataset.done === 'true'; });
    document.querySelectorAll('[data-sms-reply]').forEach((control) => { control.disabled = locked || !permitted('clinic'); });
    document.querySelectorAll('[data-feedback-control]').forEach((control) => { control.disabled = locked || !permitted('feedback'); });
    $('refreshButton').disabled = state.busy || state.reading;
    $('busyNote').textContent = state.busy ? 'Saving action… please wait' : state.recovery ? 'Refresh state before retrying an action' : !permitted('write') ? 'Read-only role · operational writes disabled' : 'Actions are serialized · permissions enforced by server';
  }

  function feederName(id) {
    const feeder = state.live && state.live.feeders && state.live.feeders.find((item) => Number(item.id) === Number(id));
    return feeder ? feeder.name : `Feeder ${id}`;
  }

  function renderTemperatureAlarm(data, receivedAt) {
    const clinics = Array.isArray(data && data.clinics) ? data.clinics : [];
    const alarmRows = clinics.map((clinic) => ({ clinic, alarm: temperatureAlarm(clinic, data) }));
    const active = alarmRows.filter((row) => row.alarm.active);
    const stale = alarmRows.filter((row) => row.alarm.stale);
    const threshold = alarmRows.find((row) => finite(row.alarm.threshold))?.alarm.threshold || (finite(data && data.temperature_alarm_threshold_c) ? Number(data.temperature_alarm_threshold_c) : THERMAL_ALARM_THRESHOLD);
    const thresholdLabel = `>${formatAlarmThreshold(threshold)}°C`;
    els.temperatureAlarmThreshold.textContent = thresholdLabel;
    const currentUnavailable = state.stateStale;
    const displayCount = currentUnavailable ? '—' : String(active.length);
    els.temperatureAlarmCount.textContent = displayCount;
    if (currentUnavailable) {
      els.temperatureAlarmCountLabel.textContent = active.length || stale.length ? `Last known: ${active.length + stale.length} alarm${active.length + stale.length === 1 ? '' : 's'}` : 'Current count unavailable';
      els.temperatureAlarmStatus.textContent = 'Current alarm state unavailable · retained readings are last known.';
    } else if (active.length) {
      els.temperatureAlarmCountLabel.textContent = `${active.length} fresh reading${active.length === 1 ? '' : 's'} above threshold`;
      els.temperatureAlarmStatus.textContent = `${active.length} clinic${active.length === 1 ? '' : 's'} above the ${thresholdLabel} alarm threshold.`;
    } else if (stale.length) {
      els.temperatureAlarmCountLabel.textContent = `${stale.length} stale alarm candidate${stale.length === 1 ? '' : 's'} excluded`;
      els.temperatureAlarmStatus.textContent = `No fresh alarms · ${stale.length} stale reading${stale.length === 1 ? '' : 's'} excluded from the count.`;
    } else {
      els.temperatureAlarmCountLabel.textContent = 'No fresh alarm readings';
      els.temperatureAlarmStatus.textContent = `No current clinic exceeds the ${thresholdLabel} alarm threshold.`;
    }
    els.temperatureAlarmLastRefresh.textContent = receivedAt || state.received || data.timestamp ? localTime(receivedAt || state.received || data.timestamp) : '—';
    els.temperatureAlarmPanel.classList.toggle('active', !currentUnavailable && active.length > 0);
    els.temperatureAlarmPanel.classList.toggle('stale', currentUnavailable || stale.length > 0);
  }
  function updateSystemAlarm(status) {
    state.alarmStatus = alarmLevel(status);
    if (!isAlertLevel(state.alarmStatus)) { stopAlarmSound(); state.audioError = null; }
    else if (state.soundEnabled && !state.alarmPlaybackActive && !state.alarmPlaybackStarting) startAlarmSound();
    renderAlarmSoundStatus();
  }

  function renderSummary(data) {
    const summary = data.summary || {};
    $('poweredClinics').textContent = formatNumber(summary.powered_clinics);
    $('totalClinics').textContent = formatNumber(summary.total_clinics);
    $('activeFeeders').textContent = formatNumber(summary.active_feeders);
    $('totalFeeders').textContent = formatNumber(summary.total_feeders);
    $('criticalClinics').textContent = formatNumber(summary.critical_clinics);
    const warning = finite(summary.warning_clinics) ? summary.warning_clinics : null;
    $('poweredSub').textContent = summary.total_clinics ? `${Math.round((summary.powered_clinics / summary.total_clinics) * 100)}% of network online` : 'Powered clinics';
    $('feederSub').textContent = summary.total_feeders ? `${Math.round((summary.active_feeders / summary.total_feeders) * 100)}% feeder availability` : 'Feeder availability';
    $('riskSub').textContent = `Warning: ${warning == null ? '—' : warning}`;
    const powerRatio = summary.total_clinics ? Math.max(0, Math.min(100, summary.powered_clinics / summary.total_clinics * 100)) : 0;
    const feederRatio = summary.total_feeders ? Math.max(0, Math.min(100, summary.active_feeders / summary.total_feeders * 100)) : 0;
    $('poweredProgress').style.width = `${powerRatio}%`; $('feederProgress').style.width = `${feederRatio}%`;
    const reportedHealth = String(summary.system_health || 'Unknown');
    const clinics = Array.isArray(data.clinics) ? data.clinics : [];
    const feeders = Array.isArray(data.feeders) ? data.feeders : [];
    const fresh = (clinic) => freshReading(clinic);
    const criticalNow = clinics.some((clinic) => fresh(clinic) && (clinic.risk_level === 'Critical' || clinic.temperature_alarm_level === 'critical' || (finite(clinic.temperature_c) && (Number(clinic.temperature_c) < 2 || Number(clinic.temperature_c) > 8))));
    const warningNow = clinics.some((clinic) => fresh(clinic) && (clinic.risk_level === 'Warning' || clinic.temperature_alarm_level === 'warning' || clinic.power_on === false || (finite(clinic.temperature_c) && Number(clinic.temperature_c) > 6))) || feeders.some((feeder) => feeder.online === false);
    const derivedHealth = criticalNow ? 'Critical' : warningNow ? 'Warning' : reportedHealth;
    const health = Number(data.stale_sensor_count) > 0 && riskClass(derivedHealth) === 'safe' ? 'Unknown / stale' : derivedHealth; const healthClass = riskClass(health);
    $('systemHealth').textContent = health; $('healthSub').textContent = 'Risk posture from live state'; $('healthDot').className = `health-dot ${healthClass}`; $('healthTrack').parentElement.className = `health-track ${healthClass}`; updateSystemAlarm(health);
    const total = Number(summary.total_clinics) || 0; $('criticalBar').style.width = total ? `${(Number(summary.critical_clinics || 0) / total) * 100}%` : '0%'; $('warningBar').style.width = total ? `${(Number(summary.warning_clinics || 0) / total) * 100}%` : '0%';
  }

  function renderHeader(data) {
    els.simClock.textContent = localTime(data.timestamp);
    els.horizon.textContent = data.horizon_hours == null ? '—' : `${data.horizon_hours} hours`;
    els.lastSync.textContent = data.timestamp ? localTime(data.timestamp) : '—';
  }

  function renderFeeders(data) {
    const feeders = Array.isArray(data.feeders) ? data.feeders : [];
    els.feederGrid.innerHTML = feeders.length ? feeders.map((feeder) => {
      const unknown = feeder.online == null || (feeder.data_quality && feeder.data_quality !== 'ok');
      const online = feeder.online === true && !unknown;
      const label = unknown ? 'UNKNOWN' : online ? 'ONLINE' : 'OFFLINE';
      return `<article class="feeder-card ${unknown ? 'unknown' : online ? '' : 'offline'}"><div class="feeder-top"><span class="feeder-id">FD-${escapeHtml(String(feeder.id).padStart(2, '0'))}</span><span class="feeder-state"><i class="legend-dot ${unknown ? 'unknown' : online ? 'online' : 'offline'}"></i>${label}</span></div><div class="feeder-name">${escapeHtml(feeder.name || `Feeder ${feeder.id}`)}</div><div class="feeder-clinics">${formatNumber(feeder.clinic_count)} linked clinics · ${escapeHtml(feeder.data_quality || 'unknown')}</div><div class="feeder-bar" aria-label="${label}"><span></span></div></article>`;
    }).join('') : '<div class="empty-state">No feeder data returned by the API.</div>';
  }

  function setSelectOptions(select, items, valueFor, labelFor, preferred) {
    const current = select.value;
    select.innerHTML = items.map((item) => `<option value="${escapeHtml(valueFor(item))}">${escapeHtml(labelFor(item))}</option>`).join('');
    const candidates = [current, preferred];
    const choice = candidates.find((value) => value && Array.from(select.options).some((option) => option.value === String(value)));
    if (choice) select.value = choice;
  }

  function renderSelects(data) {
    const feeders = Array.isArray(data.feeders) ? data.feeders : [];
    const clinics = Array.isArray(data.clinics) ? data.clinics : [];
    setSelectOptions(els.feederSelect, feeders, (item) => item.id, (item) => `${item.name || `Feeder ${item.id}`} · ${item.online == null || item.data_quality !== 'ok' ? 'unknown' : item.online ? 'online' : 'offline'}`, 3);
    setSelectOptions(els.clinicSelect, clinics, (item) => item.id, (item) => `${item.id} · ${item.name}`, clinics[0] && clinics[0].id);
    const previousFilter = els.feederFilter.value;
    els.feederFilter.innerHTML = '<option value="all">All feeders</option>' + feeders.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name || `Feeder ${item.id}`)}</option>`).join('');
    if (feeders.some((item) => String(item.id) === previousFilter)) els.feederFilter.value = previousFilter;
  }

  function thermalForecastMarkup(clinic) {
    const forecast = clinic && clinic.thermal_forecast;
    if (!forecast || forecast.status !== 'SIMULATED') return '';
    if (forecast.reliability !== 'reliable' || !finite(forecast.forecast_temperature_c)) {
      return '<span class="thermal-forecast thermal-forecast-unreliable">SIMULATED forecast unavailable · no countdown</span>';
    }
    const uncertainty = finite(forecast.uncertainty_c) ? `±${formatNumber(forecast.uncertainty_c, 1)}°C` : 'uncertainty unavailable';
    const horizon = finite(forecast.horizon_hours) ? `${formatNumber(forecast.horizon_hours, 0)}h` : '6h';
    const limit = finite(forecast.time_to_limit_hours) ? `limit in ${formatNumber(forecast.time_to_limit_hours, 1)}h` : forecast.possible_limit_breach ? 'uncertain limit breach possible' : `no limit breach in ${horizon}`;
    return `<span class="thermal-forecast">SIMULATED · ${horizon} ${formatNumber(forecast.forecast_temperature_c, 1)}°C ${uncertainty}</span><span class="thermal-limit">${escapeHtml(limit)}</span>`;
  }

  function drawPowerCutForecastChart(forecast) {
    const canvas = els.powerCutChart;
    if (!canvas) return;
    const points = forecast && Array.isArray(forecast.trajectory) ? forecast.trajectory : [];
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(320, rect.width || canvas.parentElement?.clientWidth || 320);
    const height = Math.max(210, rect.height || 230);
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio; canvas.height = height * ratio;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height);
    canvas.setAttribute('aria-label', 'Simulated fridge temperature forecast after a power cut');
    if (!points.length) { ctx.fillStyle = '#b4c7db'; ctx.font = '14px system-ui'; ctx.fillText('No simulated forecast available', 18, height / 2); return; }
    const values = points.flatMap((point) => [Number(point.low_c), Number(point.high_c), Number(point.temperature_c)]).filter(Number.isFinite);
    const minTemp = Math.min(0, Math.floor(Math.min(...values, 2) - 1));
    const maxTemp = Math.max(10, Math.ceil(Math.max(...values, 8) + 1));
    const pad = { left: 42, right: 18, top: 14, bottom: 30 };
    const plotW = width - pad.left - pad.right; const plotH = height - pad.top - pad.bottom;
    const x = (index) => pad.left + (points.length === 1 ? plotW / 2 : index / (points.length - 1) * plotW);
    const y = (value) => pad.top + (maxTemp - Number(value)) / (maxTemp - minTemp) * plotH;
    ctx.font = '12px system-ui'; ctx.lineWidth = 1;
    for (let value = minTemp; value <= maxTemp; value += 2) {
      const lineY = y(value); ctx.strokeStyle = 'rgba(141,167,182,.22)'; ctx.beginPath(); ctx.moveTo(pad.left, lineY); ctx.lineTo(pad.left + plotW, lineY); ctx.stroke(); ctx.fillStyle = '#b4c7db'; ctx.fillText(`${value}°`, 4, lineY + 4);
    }
    [2, 6, 8].forEach((limit) => {
      const lineY = y(limit); ctx.strokeStyle = limit === 6 ? '#ffdc90' : '#ffa2a6'; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(pad.left, lineY); ctx.lineTo(pad.left + plotW, lineY); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = limit === 6 ? '#ffdc90' : '#ffa2a6'; ctx.fillText(`${limit}°`, width - 16, lineY + 4);
    });
    ctx.beginPath(); points.forEach((point, index) => { index ? ctx.lineTo(x(index), y(point.high_c)) : ctx.moveTo(x(index), y(point.high_c)); });
    for (let index = points.length - 1; index >= 0; index -= 1) ctx.lineTo(x(index), y(points[index].low_c));
    ctx.closePath(); ctx.fillStyle = 'rgba(86,224,206,.16)'; ctx.fill();
    ctx.beginPath(); points.forEach((point, index) => { index ? ctx.lineTo(x(index), y(point.temperature_c)) : ctx.moveTo(x(index), y(point.temperature_c)); }); ctx.strokeStyle = '#56e0ce'; ctx.lineWidth = 2.5; ctx.stroke();
    points.forEach((point, index) => { ctx.beginPath(); ctx.arc(x(index), y(point.temperature_c), 3, 0, Math.PI * 2); ctx.fillStyle = '#56e0ce'; ctx.fill(); ctx.fillStyle = '#b4c7db'; ctx.font = '12px system-ui'; ctx.fillText(`${point.hours_ahead}h`, x(index) - 7, height - 8); });
  }

  function renderPowerCutForecast(data) {
    if (!els.powerCutForecastPanel) return;
    const clinics = Array.isArray(data && data.clinics) ? data.clinics : [];
    const selected = clinics.find((clinic) => String(clinic.id) === String(els.clinicSelect.value)) || clinics[0];
    const forecast = selected && selected.power_cut_forecast;
    if (!selected || !forecast) {
      ['powerCutForecastClinic', 'powerCutCurrentTemp', 'powerCutAmbientTemp', 'powerCutAfter1h', 'powerCutAfter2h', 'powerCutAfter6h', 'powerCutTimeToLimit'].forEach((id) => { if ($(id)) $(id).textContent = 'Unavailable'; });
      if (els.powerCutForecastStatus) { els.powerCutForecastStatus.className = 'badge unknown'; els.powerCutForecastStatus.textContent = 'SIMULATED · UNKNOWN'; }
      if (els.powerCutForecastNote) els.powerCutForecastNote.textContent = 'No current simulated state is available.';
      drawPowerCutForecastChart(null); return;
    }
    const status = String(forecast.power_cut_status || 'Unknown');
    els.powerCutForecastClinic.textContent = `${selected.id} · ${selected.name}`;
    els.powerCutCurrentTemp.textContent = finite(forecast.current_temperature_c) ? `${formatNumber(forecast.current_temperature_c, 1)}°C` : 'Unavailable';
    els.powerCutAmbientTemp.textContent = finite(forecast.ambient_temperature_c) ? `${formatNumber(forecast.ambient_temperature_c, 1)}°C` : 'Unavailable';
    const safe = forecast.safe_range_c || { low_c: 2, high_c: 8 };
    els.powerCutSafeRange.textContent = `${formatNumber(safe.low_c, 0)}–${formatNumber(safe.high_c, 0)}°C`;
    els.powerCutLimit.textContent = finite(forecast.configured_limit_c) ? `>${formatNumber(forecast.configured_limit_c, 1)}°C` : 'Unavailable';
    els.powerCutAfter1h.textContent = finite(forecast.after_1h_c) ? `${formatNumber(forecast.after_1h_c, 1)}°C` : 'Unavailable';
    els.powerCutAfter2h.textContent = finite(forecast.after_2h_c) ? `${formatNumber(forecast.after_2h_c, 1)}°C` : 'Unavailable';
    els.powerCutAfter6h.textContent = finite(forecast.after_6h_c) ? `${formatNumber(forecast.after_6h_c, 1)}°C` : 'Unavailable';
    els.powerCutTimeToLimit.textContent = finite(forecast.time_to_limit_hours) ? `${formatNumber(forecast.time_to_limit_hours, 1)}h` : forecast.possible_limit_breach ? 'Uncertain' : 'No breach';
    els.powerCutForecastStatus.className = `badge ${riskClass(status)}`; els.powerCutForecastStatus.textContent = `SIMULATED · ${status.toUpperCase()}`;
    els.powerCutChartNote.textContent = forecast.reliability === 'reliable' ? 'SIMULATED ESTIMATES' : 'SIMULATED · LIMITED RELIABILITY';
    els.powerCutForecastNote.textContent = `${forecast.note || 'SIMULATED estimate.'} Safe range: ${formatNumber(safe.low_c, 0)}–${formatNumber(safe.high_c, 0)}°C. Existing Trip feeder and Local fault controls change the live state; this panel is the hypothetical cut outlook.`;
    drawPowerCutForecastChart(forecast);
  }

  function renderTable(data) {
    const clinics = Array.isArray(data.clinics) ? data.clinics : [];
    const query = els.search.value.trim().toLowerCase(); const risk = els.riskFilter.value; const feeder = els.feederFilter.value;
    const levelFor = (clinic) => clinic.data_quality && clinic.data_quality !== 'ok' ? 'Unknown' : clinic.too_cold || clinic.too_hot || (finite(clinic.temperature_c) && (Number(clinic.temperature_c) < 2 || Number(clinic.temperature_c) > 8)) ? 'Critical' : ['Safe', 'Warning', 'Critical'].includes(clinic.risk_level) ? clinic.risk_level : 'Unknown';
    const rows = clinics.filter((clinic) => (!query || `${clinic.id} ${clinic.name}`.toLowerCase().includes(query)) && (risk === 'all' || levelFor(clinic) === risk) && (feeder === 'all' || String(clinic.feeder_id) === feeder)).sort((a, b) => (Number(a.priority_rank) || 999) - (Number(b.priority_rank) || 999));
    els.tableBody.innerHTML = rows.length ? rows.map((clinic) => {
      const level = levelFor(clinic); const levelClass = riskClass(level); const power = clinic.power_on === true; const cold = clinic.too_cold || (finite(clinic.temperature_c) && Number(clinic.temperature_c) < 2); const hot = clinic.too_hot || (finite(clinic.temperature_c) && Number(clinic.temperature_c) > 8); const alarm = temperatureAlarm(clinic, data); const alarmBadge = alarm.active ? `<span class="temperature-alarm-badge">${escapeHtml(alarm.label || 'Temperature alarm')} · &gt;${escapeHtml(formatAlarmThreshold(alarm.threshold))}°C</span>` : alarm.stale ? '<span class="temperature-alarm-badge stale">Last known alarm · current reading stale</span>' : '';
      const hazard = cold || hot ? `<span class="hazard-tag">${clinic.data_quality === 'ok' ? 'Observed' : 'Last known'}: ${cold ? 'too cold (<2°C)' : 'too hot (>8°C)'}</span>` : '';
      const powerLabel = clinic.data_quality && clinic.data_quality !== 'ok' ? 'Unknown / last known' : clinic.power_on == null ? 'Unknown' : power ? 'Online' : 'Offline';
      const status = clinic.status ? `<span class="clinic-id">${escapeHtml(clinic.status)}</span>` : '';
      const smsState = String(clinic.sms_state || (clinic.sms && clinic.sms.state) || 'normal');
      const sms = clinic.sms || {};
      const replyOptions = Array.isArray(sms.reply_options) ? sms.reply_options : [];
      const replyMarkup = replyOptions.length ? `<span class="sms-replies">${replyOptions.map((reply) => `<button type="button" class="sms-reply" data-sms-reply="${escapeHtml(reply)}" data-clinic-id="${escapeHtml(clinic.id)}">${escapeHtml(reply)}</button>`).join('')}</span>` : '';
      const rank = finite(clinic.priority_rank) ? `#${formatNumber(clinic.priority_rank, 0)}` : '—';
      const beforeRank = finite(clinic.priority_rank_before_followup) ? `pre #${formatNumber(clinic.priority_rank_before_followup, 0)}` : '';
      const slack = finite(clinic.priority_slack_h) ? `${formatNumber(clinic.priority_slack_h, 1)}h` : '—';
      const slackClass = finite(clinic.priority_slack_h) && Number(clinic.priority_slack_h) < 0 ? 'critical' : finite(clinic.priority_slack_h) && Number(clinic.priority_slack_h) < 2 ? 'warning' : 'safe';
      return `<tr><td class="priority-cell"><strong>${rank}</strong><small>${escapeHtml(beforeRank)}</small></td><td><span class="clinic-name">${escapeHtml(clinic.name)}</span><span class="clinic-id">${escapeHtml(clinic.id)}</span>${status}<span class="clinic-id">Source: ${escapeHtml(text(clinic.source || clinic.risk_source))} · Quality: ${escapeHtml(text(clinic.data_quality))}</span></td><td class="feeder-cell">${escapeHtml(feederName(clinic.feeder_id))}</td><td><span class="power-state ${power && clinic.data_quality === 'ok' ? '' : 'off'}"><i></i>${powerLabel}</span><small class="power-source">${escapeHtml(clinic.power_source || '')}</small></td><td><div class="temp-stack"><span class="temp ${cold ? 'cold' : hot || alarm.active ? 'hot alarm' : ''}">${formatNumber(clinic.temperature_c, 1)}${finite(clinic.temperature_c) ? '°C' : ''}</span>${thermalForecastMarkup(clinic)}${alarmBadge}${hazard}</div></td><td><span class="weather"><span>☂ <b>${formatNumber(clinic.forecast_rain_next_6h, 1)} mm</b></span><span>≋ <b>${formatNumber(clinic.forecast_wind_next_6h, 1)} km/h</b></span></span></td><td><div class="risk-cell"><span class="risk-value">${percent(clinic.risk_probability)}</span><span class="badge ${levelClass}">${escapeHtml(level)}</span></div></td><td><span class="priority-slack ${slackClass}">${slack}</span><small class="priority-sub">8°C minus travel</small></td><td><span class="sms-state ${smsStateClass(smsState)}">${escapeHtml(smsStateLabel(smsState))}</span>${replyMarkup}</td></tr>`;
    }).join('') : '<tr><td colspan="9" class="empty-cell">No clinics match the current filters.</td></tr>';
     const policy = data.summary && data.summary.priority_policy ? ` · ${data.summary.priority_policy}` : '';
     els.tableSummary.textContent = `Showing ${rows.length} of ${clinics.length} clinics · ranked by simulated 8°C safety slack${policy}. SMS states and replies are simulated; model probabilities appear only when available. Observed temperature violations elevate risk independently.`;
  }

  function renderState(data, receivedAt) {
    state.live = data; renderHeader(data); renderSummary(data); renderFeeders(data); renderSelects(data); renderTemperatureAlarm(data, receivedAt); renderTable(data); renderPowerCutForecast(data);
  }

  function renderThermalValidation(data) {
    if (!els.thermalForecastValidation || !els.thermalValidationText) return;
    const validation = data && data.thermal_forecast_validation;
    if (!validation) {
      els.thermalForecastValidation.classList.add('unavailable');
      els.thermalValidationText.textContent = 'SIMULATED validation results are unavailable.';
      return;
    }
    const failure = validation.failure_scenarios || {};
    const crossing = finite(validation.threshold_crossing_time_mae_hours) ? `${formatNumber(validation.threshold_crossing_time_mae_hours, 2)}h` : 'no matched crossings';
    const failureMae = finite(failure.mae_c) ? `${formatNumber(failure.mae_c, 2)}°C` : 'unavailable';
    els.thermalForecastValidation.classList.remove('unavailable');
    els.thermalValidationText.textContent = `Held-out synthetic scenarios · MAE ${formatNumber(validation.mae_c, 2)}°C · RMSE ${formatNumber(validation.rmse_c, 2)}°C · threshold-crossing error ${crossing} · failure MAE ${failureMae}. Synthetic validation only.`;
  }

  function drawChart(canvas, points, color, ariaLabel) {
    const ctx = canvas.getContext('2d'); const rect = canvas.getBoundingClientRect(); const width = Math.max(260, rect.width); const height = Math.max(140, rect.height); const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio; canvas.height = height * ratio; ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height); canvas.setAttribute('aria-label', ariaLabel);
    const pad = { left: 48, right: 24, top: 16, bottom: 26 }; const plotW = width - pad.left - pad.right; const plotH = height - pad.top - pad.bottom;
    ctx.font = '13px system-ui'; ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(141,167,182,.25)'; ctx.fillStyle = '#b4c7db';
    for (let i = 0; i <= 4; i += 1) { const y = pad.top + plotH * (i / 4); const x = pad.left + plotW * (i / 4); ctx.beginPath();ctx.moveTo(pad.left,y);ctx.lineTo(pad.left+plotW,y);ctx.stroke();ctx.beginPath();ctx.moveTo(x,pad.top);ctx.lineTo(x,pad.top+plotH);ctx.stroke();ctx.fillText(`${100 - i * 25}%`, 2, y + 3); }
    ctx.fillText('0%', pad.left - 3, height - 4); ctx.fillText('100%', pad.left + plotW - 20, height - 4);
    if (!Array.isArray(points) || points.length === 0) { ctx.fillStyle = '#8da7b6';ctx.fillText('No chart data returned', pad.left + plotW / 2 - 44, pad.top + plotH / 2); return; }
    const xPos = (value) => pad.left + Math.max(0, Math.min(1, Number(value) || 0)) * plotW; const yPos = (value) => pad.top + (1 - Math.max(0, Math.min(1, Number(value) || 0))) * plotH;
    ctx.save();ctx.setLineDash([4, 4]);ctx.strokeStyle='rgba(141,167,182,.6)';ctx.beginPath();ctx.moveTo(xPos(0),yPos(0));ctx.lineTo(xPos(1),yPos(1));ctx.stroke();ctx.restore();
    const ordered = points.slice().sort((a, b) => Number(a.predicted ?? a.fpr ?? 0) - Number(b.predicted ?? b.fpr ?? 0)); ctx.beginPath();
    ordered.forEach((point, index) => { const x = xPos(point.predicted ?? point.fpr); const y = yPos(point.observed ?? point.tpr); index ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.strokeStyle = color;ctx.lineWidth=2.2;ctx.stroke();
    ordered.forEach((point) => { const x=xPos(point.predicted ?? point.fpr);const y=yPos(point.observed ?? point.tpr);ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();ctx.strokeStyle='#0d1c2b';ctx.lineWidth=1;ctx.stroke(); });
  }

  function renderModel(data) {
    state.model = data;
    renderThermalValidation(data);
    if (!data || data.ready !== true) { els.modelStatus.textContent = 'Rules-only / profile unavailable';els.modelStatus.className='model-status not-ready';els.modelUnavailable.textContent = 'Model profile is unavailable or not ready. Deterministic safeguards remain independent of model availability; missing predictions are not zero risk.';els.modelUnavailable.hidden=false;els.modelContent.hidden=true;return; }
    els.modelUnavailable.hidden = true; els.modelContent.hidden = false; els.modelStatus.textContent = data.model_name ? `${data.model_name} · ready` : 'Model ready'; els.modelStatus.className='model-status';
    const metrics = data.metrics || {}, dataset = data.dataset || {};
    $('modelName').textContent = data.model_name || '—'; $('modelHorizon').textContent = data.horizon_hours == null ? '—' : `${data.horizon_hours} hours`; $('datasetInfo').textContent = dataset.days == null ? '—' : `${dataset.days} days · ${dataset.rows || 0} rows`; $('positiveRate').textContent = percent(dataset.positive_rate);
    $('prAuc').textContent = formatNumber(metrics.pr_auc, 3); $('f2Score').textContent = formatNumber(metrics.f2, 3); $('brierScore').textContent = formatNumber(metrics.brier, 3); $('rocAuc').textContent = formatNumber(metrics.roc_auc, 3); $('threshold').textContent = percent(metrics.threshold, 1); $('prevalence').textContent = percent(metrics.prevalence, 1);
    const matrix = data.confusion_matrix || [[null, null], [null, null]]; $('matrixTn').textContent = matrix[0] && matrix[0][0] != null ? matrix[0][0] : '—'; $('matrixFp').textContent = matrix[0] && matrix[0][1] != null ? matrix[0][1] : '—'; $('matrixFn').textContent = matrix[1] && matrix[1][0] != null ? matrix[1][0] : '—'; $('matrixTp').textContent = matrix[1] && matrix[1][1] != null ? matrix[1][1] : '—';
    const importance = Array.isArray(data.feature_importance) ? data.feature_importance.slice().sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0)) : []; const maxImportance = Math.max(...importance.map((item) => finite(item.importance) ? Number(item.importance) : 0), 0); const importanceBucket = (item) => maxImportance && finite(item.importance) ? Math.max(0, Math.min(10, Math.round(Number(item.importance) / maxImportance * 10))) : 0; $('featureImportance').innerHTML = importance.length ? importance.map((item) => `<div class="importance-row"><span class="importance-label" title="${escapeHtml(item.feature)}">${escapeHtml(item.feature)}</span><span class="importance-bar"><span class="importance-fill importance-fill-${importanceBucket(item)}"></span></span><span class="importance-value">${formatNumber(item.importance, 3)}</span></div>`).join('') : '<div class="empty-state">No feature importance data returned.</div>';
    const notes = Array.isArray(data.notes) ? data.notes : []; const notesWrap = $('modelNotes'); notesWrap.hidden = !notes.length; if (notes.length) notesWrap.querySelector('ul').innerHTML = notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('');
    drawChart($('reliabilityChart'), data.calibration, '#38d6c3', 'Reliability curve: observed outcome versus predicted probability'); drawChart($('rocChart'), data.roc_curve, '#f5a35b', 'ROC curve: true positive rate versus false positive rate');
  }

  function details(items) {
    const valueMarkup = (value) => {
      if (value == null) return 'Unavailable';
      if (Array.isArray(value)) return value.length ? value.map((item) => valueMarkup(item)).join(' · ') : 'No values reported';
      if (typeof value === 'object') return details(Object.entries(value).map(([key, item]) => [key.replace(/_/g, ' '), item]));
      return escapeHtml(typeof value === 'boolean' ? value ? 'Yes' : 'No' : text(value));
    };
    return `<dl class="detail-grid">${items.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${valueMarkup(value)}</dd></div>`).join('')}</dl>`;
  }
  function renderTelemetry(data) {
    const telemetry = data.telemetry_status;
    const label = typeof telemetry === 'string' ? telemetry : telemetry && telemetry.status;
    const stale = Number(data.stale_sensor_count) > 0 || /stale|unknown|missing/i.test(label || 'unknown');
    $('telemetryContent').innerHTML = `<span class="badge ${stale ? 'warning' : 'safe'}">${escapeHtml(label || 'Unknown telemetry status')}</span>${details([['Stale sensors', data.stale_sensor_count], ['Active source mode', data.telemetry_mode || data.source || (telemetry && telemetry.source) || 'Unknown — check each reading'], ['Data quality', data.data_quality || (telemetry && telemetry.data_quality) || 'See individual readings']])}`;
  }
  function renderAlerts(data) {
    if (!Array.isArray(data.alerts)) throw new Error('Alert response is missing its alert list.');
    $('alertsList').classList.remove('skeleton-block');
    $('alertsList').innerHTML = data.alerts.length ? data.alerts.map((alert) => {
      const done = !!alert.acknowledged_by || /acknowledged|resolved|closed/i.test(alert.status || '');
      return `<article class="alert-item"><div><span class="badge ${riskClass(alert.severity)}">${escapeHtml(text(alert.severity))}</span> <span class="badge">${escapeHtml(text(alert.status))}</span><h5>${escapeHtml(text(alert.message))}</h5><p>Next action: ${escapeHtml(text(alert.next_action))}</p><div class="alert-meta">${escapeHtml(text(alert.entity_id))} · ${escapeHtml(text(alert.kind))} · ${escapeHtml(localTime(alert.observed_at))}<br>Acknowledged by: ${escapeHtml(alert.acknowledged_by || 'Not acknowledged')} · Escalation: ${escapeHtml(text(alert.escalation_level))} · Delivery: ${escapeHtml(text(alert.delivery_status))}<br>Demo-log only · no real SMS sent</div></div><button class="btn btn-secondary" data-ack="${escapeHtml(alert.id)}" data-done="${done}" ${done || !permitted('write') ? 'disabled' : ''}>${done ? 'Recorded / closed' : 'Acknowledge'}</button></article>`;
    }).join('') : '<p class="muted">No alerts returned. This is not a clinical safety guarantee.</p>';
  }
  function renderWeather(data) {
    const fallback = data.fallback === true;
    const stale = data.stale == null ? 'Freshness unknown' : data.stale ? 'Stale weather' : 'Provider reports current';
    $('weatherContent').classList.remove('skeleton-block');
    $('weatherContent').innerHTML = `<span class="badge ${fallback || data.stale ? 'warning' : 'unknown'}">${escapeHtml(stale)}</span> <span class="badge">${fallback ? 'Fallback active' : data.fallback === false ? 'No fallback reported' : 'Fallback unknown'}</span>${details([['Provider', data.provider], ['Observed at', localTime(data.observed_at)], ['Temperature', finite(data.temperature_c) ? `${formatNumber(data.temperature_c, 1)} °C` : null], ['Rain', finite(data.rain_mm) ? `${formatNumber(data.rain_mm, 1)} mm` : null], ['Wind', finite(data.wind_kmh) ? `${formatNumber(data.wind_kmh, 1)} km/h` : null], ['Rain forecast · next 6h', finite(data.forecast_rain_next_6h) ? `${formatNumber(data.forecast_rain_next_6h, 1)} mm` : null], ['Wind forecast · next 6h', finite(data.forecast_wind_next_6h) ? `${formatNumber(data.forecast_wind_next_6h, 1)} km/h` : null]])}`;
  }
  function renderMonitoring(data) {
    $('monitoringContent').classList.remove('skeleton-block');
    $('monitoringContent').innerHTML = details([['Predictions recorded', data.prediction_count], ['Human outcome records', data.feedback_count], ['Recent data quality', data.recent_data_quality], ['Stale sensors', data.stale_sensor_count], ['Risk distribution', data.risk_distribution], ['Outcome performance', data.performance], ['Drift evidence', data.drift]]);
    const predictions = Array.isArray(data.recent_predictions) ? data.recent_predictions.filter((item) => item.id != null) : [];
    $('feedbackForm').hidden = !predictions.length;
    if (predictions.length) {
      setSelectOptions($('predictionSelect'), predictions, (item) => item.id, (item) => `#${item.id} · ${item.clinic_id} · ${percent(item.probability)} · ${text(item.risk_level)} · ${localTime(item.observed_at)}`);
      if (!permitted('feedback')) $('feedbackStatus').textContent = 'Your role is read-only for outcome feedback.';
    } else $('monitoringContent').insertAdjacentHTML('beforeend', '<p class="muted">Outcome entry becomes available when the API exposes recent prediction IDs.</p>');
  }
  function renderPolicy(data) {
    $('policyContent').classList.remove('skeleton-block');
    const safeguards = Array.isArray(data.deterministic_safeguards) ? data.deterministic_safeguards : [];
    $('policyContent').innerHTML = `<h4>Hard rules operate independently of the model</h4>${safeguards.length ? `<ul>${safeguards.map((rule) => `<li>${escapeHtml(text(rule))}</li>`).join('')}</ul>` : '<p>Safeguards unavailable. Do not infer that checks have passed.</p>'}${details([['Medical status', data.medical_status], ['Validation status', data.validation_status || 'not_validated'], ['Missing-data behavior', data.missing_data], ['Retention', data.retention], ['Authentication mode', data.auth_mode]])}<h4>Role policy</h4>${details(Object.entries(data.roles || {}))}`;
  }
  function renderAudit(data) {
    if (!Array.isArray(data.entries)) throw new Error('Audit response is missing its entries.');
    $('auditContent').innerHTML = data.entries.length ? data.entries.map((entry) => `<article class="audit-entry"><strong>${escapeHtml(text(entry.action))}</strong><p>${escapeHtml(text(entry.actor))} · ${escapeHtml(text(entry.resource))}</p><p class="muted">#${escapeHtml(text(entry.id))} · ${escapeHtml(localTime(entry.created_at))}</p><pre>${escapeHtml(text(entry.detail))}</pre></article>`).join('') : '<p>No audit entries returned.</p>';
  }
  function renderAuthoritySummary(data) {
    [['authorityTotalClinics', data.total_clinics], ['authorityActiveClinics', data.active_clinics], ['authorityWarningClinics', data.warning_clinics], ['authorityCriticalClinics', data.critical_clinics], ['authorityOfflineClinics', data.offline_clinics]].forEach(([id, value]) => { if ($(id)) $(id).textContent = formatNumber(value, 0); });
  }
  function authorityStatusMarkup(row) {
    const power = String(row.power_status || 'unknown'); const connection = String(row.connection_status || 'unknown');
    return `<span class="authority-status-${escapeHtml(power === 'offline' ? 'offline' : connection === 'stale' ? 'stale' : connection === 'online' ? 'online' : 'warning')}">${escapeHtml(power.toUpperCase())}</span><small class="power-source">${escapeHtml(connection)} connection</small>`;
  }
  function renderAuthorityClinics(data) {
    authorityClinics = Array.isArray(data.clinics) ? data.clinics : [];
    if (!els.authorityClinicBody) return;
    els.authorityClinicBody.innerHTML = authorityClinics.length ? authorityClinics.map((row) => {
      const id = row.id || row.clinic_id; const risk = row.risk_level || 'Unknown'; const temperature = finite(row.temperature_c) ? `${formatNumber(row.temperature_c, 1)}°C` : '—';
      return `<tr data-authority-clinic="${escapeHtml(id)}"><td><strong>${escapeHtml(row.name || id)}</strong><small class="clinic-id">${escapeHtml(id)}</small></td><td>${escapeHtml(row.location || 'Unassigned')}</td><td>${authorityStatusMarkup(row)}</td><td>${temperature}</td><td><span class="badge ${riskClass(risk)}">${escapeHtml(risk)}</span></td><td>${escapeHtml(row.connection_status || 'unknown')}</td><td><button type="button" class="btn btn-secondary" data-authority-open="${escapeHtml(id)}">Open</button></td></tr>`;
    }).join('') : '<tr><td colspan="7" class="empty-cell">No registered clinics match these filters.</td></tr>';
  }
  function renderAuthorityFollowups(data) {
    const rows = Array.isArray(data.followups) ? data.followups : [];
    if ($('authorityFollowupCount')) $('authorityFollowupCount').textContent = `${rows.filter((row) => row.status === 'pending').length} pending`;
    if (els.authorityFollowupList) els.authorityFollowupList.innerHTML = rows.length ? rows.map((row) => `<article class="authority-followup-item"><h5>${escapeHtml(row.clinic_id)} · ${escapeHtml(row.status)}</h5><p>${escapeHtml(row.message)}</p><p class="muted">Requested by ${escapeHtml(row.requested_by)} · ${escapeHtml(localTime(row.created_at))}</p>${row.response ? `<div class="followup-response"><b>Response:</b> ${escapeHtml(row.response)}<br><small>${escapeHtml(row.responded_by || '')} · ${escapeHtml(localTime(row.responded_at))}</small></div>` : '<p class="muted">Awaiting clinic response.</p>'}</article>`).join('') : '<p class="muted">No follow-up requests recorded.</p>';
  }
  function renderAuthorityDetail(data) {
    const clinic = data.clinic || {}; const id = clinic.id || clinic.clinic_id; authorityClinicId = id;
    if (els.authorityClinicDetail) els.authorityClinicDetail.hidden = false;
    if (els.authorityDetailTitle) els.authorityDetailTitle.textContent = `${clinic.name || id} · ${id}`;
    if (els.authorityDetailContent) els.authorityDetailContent.innerHTML = `${details([['Location', clinic.location], ['Power status', clinic.power_status], ['Connection', clinic.connection_status], ['Current temperature', finite(clinic.temperature_c) ? `${formatNumber(clinic.temperature_c, 1)}°C` : null], ['Risk level', clinic.risk_level], ['Observed at', localTime(clinic.observed_at)]])}<h5>Temperature history</h5>${details([['Readings', Array.isArray(data.temperature_history) ? data.temperature_history.length : 0], ['Latest telemetry', data.temperature_history && data.temperature_history[0] ? data.temperature_history[0].payload : null]])}<h5>Forecast</h5>${details([['Simulated forecast', data.forecast || 'Unavailable']])}<h5>Alerts</h5>${Array.isArray(data.alerts) && data.alerts.length ? data.alerts.map((item) => `<p><span class="badge ${riskClass(item.severity)}">${escapeHtml(item.severity)}</span> ${escapeHtml(item.message)}</p>`).join('') : '<p class="muted">No clinic alerts.</p>'}`;
    if (els.authorityFollowupForm) els.authorityFollowupForm.hidden = !authorityEnabled();
  }
  async function openAuthorityClinic(clinicId) {
    const data = await api(`/api/authority/clinics/${encodeURIComponent(clinicId)}`);
    renderAuthorityDetail(data);
  }
  async function loadAuthority(generation) {
    if (!authorityEnabled() || !state.active) return;
    const search = encodeURIComponent(($('authoritySearch') && $('authoritySearch').value.trim()) || '');
    const status = encodeURIComponent(($('authorityStatusFilter') && $('authorityStatusFilter').value) || 'all');
    const location = encodeURIComponent(($('authorityLocationFilter') && $('authorityLocationFilter').value.trim()) || '');
    const risk = encodeURIComponent(($('authorityRiskFilter') && $('authorityRiskFilter').value) || 'all');
    const [summary, clinics, followups] = await Promise.all([api('/api/authority/summary'), api(`/api/authority/clinics?search=${search}&status=${status}&location=${location}&risk_level=${risk}`), api('/api/authority/followups')]);
    if (generation != null && generation !== state.generation) return;
    renderAuthoritySummary(summary); renderAuthorityClinics(clinics); renderAuthorityFollowups(followups);
  }
  const panels = { alerts: renderAlerts, weather: renderWeather, monitoring: renderMonitoring, policy: renderPolicy, audit: renderAudit };
  function toast(message) {
    $('toastRegion').replaceChildren();
    const notification = document.createElement('div'); notification.className = 'toast'; notification.textContent = message; $('toastRegion').append(notification);
    clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => notification.remove(), 6500);
  }
  function invalidate() {
    state.generation += 1; clearTimeout(state.pollTimer); clearTimeout(state.fullPollTimer);
    state.reads.forEach((controller) => controller.abort()); state.reads.clear(); state.reading = false;
    return state.generation;
  }
  function connection(ok, message) {
    state.stateStale = !ok;
    document.body.classList.toggle('disconnected', !ok);
    $('connectionStatus').textContent = message;
    $('connectionStatus').parentElement.classList.toggle('stale', !ok);
    if (!ok) {
      $('systemHealth').textContent = state.live ? 'Stale / disconnected' : 'Unknown';
      $('healthSub').textContent = state.live ? 'Retained values are last known, not live' : 'No current state available';
      $('healthDot').className = 'health-dot warning'; $('healthTrack').parentElement.className = 'health-track unknown';
      $('telemetryContent').innerHTML = '<span class="badge warning">Stale / unknown — state connection unavailable</span><p>Last-known readings must not be treated as current.</p>';
      if (state.live) { renderTemperatureAlarm(state.live, state.received); renderTable(state.live); }
    }
  }
  function lockSession(message) {
    invalidate(); clearTimeout(state.expiryTimer); clearTimeout(state.toastTimer); disposeAlarmAudio();
    state.token = null; state.user = null; state.active = false; state.busy = false; state.recovery = false; state.recoveryFor = null; state.received = null; state.panels = {}; state.stateStale = false; state.soundEnabled = false; state.userMuted = false; state.audioError = null; state.alarmStatus = 'Unknown';
    renderState({}); state.live = null; renderModel(null); state.model = null;
    ['alertsList', 'weatherContent', 'telemetryContent', 'monitoringContent', 'policyContent', 'auditContent', 'sessionIdentity', 'toastRegion', 'feedbackStatus', 'featureImportance'].forEach((id) => { $(id).replaceChildren(); });
    ['modelName', 'modelHorizon', 'datasetInfo', 'positiveRate', 'prAuc', 'f2Score', 'brierScore', 'rocAuc', 'threshold', 'prevalence', 'matrixTn', 'matrixFp', 'matrixFn', 'matrixTp'].forEach((id) => { $(id).textContent = '—'; });
    $('modelNotes').querySelector('ul').replaceChildren(); $('modelNotes').hidden = true; $('connectionStatus').textContent = 'Signed out';
    Object.keys(panels).forEach((name) => { $(`${name}Status`).textContent = 'Waiting for connection…'; $(`${name}Status`).className = 'panel-status'; });
    $('feedbackForm').reset(); $('feedbackForm').hidden = true; $('predictionSelect').replaceChildren(); $('clinicSearch').value = ''; $('riskFilter').value = 'all';
    ['reliabilityChart', 'rocChart'].forEach((id) => { const canvas = $(id); canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); });
    $('dashboard').hidden = true; $('sectionNav').hidden = true; $('auditSection').hidden = true; if (els.authoritySection) els.authoritySection.hidden = true; if (els.authorityNav) els.authorityNav.hidden = true;
    authorityClinics = []; authorityClinicId = null;
    if (els.authorityClinicDetail) els.authorityClinicDetail.hidden = true;
    if ($('authorityRegisterForm')) $('authorityRegisterForm').hidden = true;
    $('authPanel').hidden = false; $('authStatus').textContent = message; $('loginForm').hidden = !state.config; $('loginForm').reset();
    $('demoEnter').hidden = !isDemo(); $('retryAuth').hidden = !!state.config; $('loginButton').disabled = false; $('demoEnter').disabled = false;
    els.loading.hidden = true; hideError(); updateAlarmSoundButton(); setControlsDisabled(false);
  }
  function isDemo() { return state.config && state.config.auth_mode === 'demo' && state.config.demo !== false; }
  function enterSession(user, token, expires) {
    if (!user || !['clinic_operator', 'grid_operator', 'admin', 'authority', 'auditor'].includes(user.role)) throw new Error('The server returned an unsupported user role.');
    invalidate(); state.user = user; state.token = token || null; state.active = true; state.recovery = false;
    $('authPanel').hidden = true; $('dashboard').hidden = false; $('sectionNav').hidden = false; if (els.authoritySection) els.authoritySection.hidden = !authorityEnabled(); if (els.authorityNav) els.authorityNav.hidden = !authorityEnabled();
    $('sessionIdentity').textContent = token ? `${user.username} · ${user.role}` : 'Local demo · auth bypassed';
    $('optionalSignIn').hidden = !!token || !isDemo(); $('auditSection').hidden = !permitted('audit');
    $('password').value = ''; $('loginButton').disabled = false; $('demoEnter').disabled = false; clearTimeout(state.expiryTimer);
    if (token && finite(expires) && Number(expires) > 0) state.expiryTimer = setTimeout(() => lockSession('Session expired. Sign in again to continue.'), Math.min(Number(expires) * 1000, 2147483647));
    setControlsDisabled(false); refreshAll();
  }
  async function enterDemo() {
    if (!isDemo()) return;
    const generation = invalidate(); $('demoEnter').disabled = true; $('loginButton').disabled = true; $('authStatus').textContent = 'Connecting to local demo…';
    try { const user = await api('/api/auth/me'); if (generation === state.generation) enterSession(user.user || user, null); }
    catch (error) { if (generation === state.generation) $('authStatus').textContent = `Demo access unavailable. ${error.message}`; }
    finally { if (generation === state.generation) { $('demoEnter').disabled = false; $('loginButton').disabled = false; } }
  }
  async function configureAuth() {
    const generation = invalidate(); $('retryAuth').hidden = true; $('authStatus').textContent = 'Checking authentication configuration…';
    try {
      const config = await api('/api/auth/config');
      if (generation !== state.generation) return;
      if (!['demo', 'required'].includes(config.auth_mode)) throw new Error('Authentication configuration is unavailable or unsupported.');
      state.config = config; $('loginForm').hidden = false; $('demoEnter').hidden = !isDemo();
      if (isDemo()) await enterDemo(); else $('authStatus').textContent = 'Authentication required. Sign in before accessing operational data.';
    } catch (error) { if (generation === state.generation) { $('authStatus').textContent = `Cannot verify access configuration. ${error.message}`; $('retryAuth').hidden = false; } }
  }
  function scheduleDashboardPoll() {
    clearTimeout(state.pollTimer);
    if (state.active && !document.hidden && !state.recovery) state.pollTimer = setTimeout(() => pollDashboardState(), 3000);
  }
  function scheduleFullPoll() {
    clearTimeout(state.fullPollTimer);
    if (state.active && !document.hidden && !state.recovery) state.fullPollTimer = setTimeout(() => {
      if (state.busy || state.reading) scheduleFullPoll(); else refreshAll();
    }, 15000);
  }
  async function pollDashboardState() {
    if (!state.active || document.hidden || state.busy || state.reading || state.recovery) { scheduleDashboardPoll(); return; }
    clearTimeout(state.pollTimer); const generation = state.generation; state.reading = true; setControlsDisabled(false);
    try {
      const data = await api('/api/state');
      if (generation !== state.generation || !state.active) return;
      if (!Array.isArray(data.clinics) || !Array.isArray(data.feeders)) throw new Error('State response is missing clinics or feeders.');
      const receivedAt = new Date().toISOString(); state.received = receivedAt; state.stateStale = false; renderState(data, receivedAt); renderTelemetry(data);
      const mode = state.token ? 'Authenticated session' : 'Local demo · auth bypassed';
      connection(true, `${mode} · Connected · Received ${localTime(receivedAt)}`); els.lastSync.textContent = localTime(receivedAt);
    } catch (error) {
      if (generation !== state.generation || !state.active) return;
      connection(false, `Disconnected · ${state.received ? `Last known data received ${localTime(state.received)}` : 'No current data'} · ${error.message}`);
    } finally {
      if (generation === state.generation && state.active) { state.reading = false; setControlsDisabled(false); scheduleDashboardPoll(); }
    }
  }
  async function refreshAll(manual = false) {
    if (!state.active || state.busy || state.reading || document.hidden) return;
    clearTimeout(state.pollTimer); clearTimeout(state.fullPollTimer); const generation = state.generation; state.reading = true; setControlsDisabled(false);
    els.loading.hidden = !!state.live; $('dashboard').setAttribute('aria-busy', 'true');
    let stateOk = false;
    try {
      const data = await api('/api/state');
      if (generation !== state.generation || !state.active) return;
      if (!Array.isArray(data.clinics) || !Array.isArray(data.feeders)) throw new Error('State response is missing clinics or feeders.');
      const receivedAt = new Date().toISOString(); state.received = receivedAt; state.stateStale = false; renderState(data, receivedAt); renderTelemetry(data); stateOk = true;
      const mode = state.token ? 'Authenticated session' : 'Local demo · auth bypassed';
      connection(true, `${mode} · Connected · Received ${localTime(state.received)}`);
      els.lastSync.textContent = localTime(state.received);
    } catch (error) {
      if (generation !== state.generation || !state.active) return;
      connection(false, `Disconnected · ${state.received ? `Last known data received ${localTime(state.received)}` : 'No current data'} · ${error.message}`);
    }
    if (generation !== state.generation || !state.active) return;
     const names = ['model', 'alerts', 'weather', 'monitoring', 'policy', ...(permitted('audit') ? ['audit'] : [])];
     const results = await Promise.allSettled(names.map(async (name) => {
       const data = await api(name === 'alerts' ? '/api/alerts?include_resolved=false' : `/api/${name}`);
      if (generation !== state.generation || !state.active) return;
      if (name === 'model') renderModel(data); else panels[name](data);
      state.panels[name] = new Date().toISOString();
      if (name !== 'model') { $(`${name}Status`).textContent = `Received ${localTime(state.panels[name])}`; $(`${name}Status`).className = 'panel-status'; }
    }));
    if (generation !== state.generation || !state.active) return;
     results.forEach((result, index) => {
      if (result.status !== 'rejected') return;
      const name = names[index]; const message = `${state.panels[name] ? `Last known · ${localTime(state.panels[name])}` : 'Unavailable'} · ${result.reason.message}`;
      if (name === 'model') { if (!state.model) renderModel(null); els.modelStatus.textContent = message; els.modelStatus.className = 'model-status not-ready'; }
      else {
        $(`${name}Status`).textContent = message; $(`${name}Status`).className = 'panel-status stale';
        const content = $(name === 'alerts' ? 'alertsList' : `${name}Content`); content.classList.remove('skeleton-block');
        if (!state.panels[name]) content.textContent = 'No current data. Refresh to reconnect.';
       }
     });
     if (authorityEnabled()) {
       try { await loadAuthority(generation); } catch (error) {
         if (generation === state.generation && els.authorityClinicBody) els.authorityClinicBody.innerHTML = `<tr><td colspan="7" class="empty-cell">Authority data unavailable: ${escapeHtml(error.message)}</td></tr>`;
       }
     }
     const recoveryIndex = names.indexOf(state.recoveryFor);
    const recovered = stateOk && (recoveryIndex < 0 || results[recoveryIndex].status === 'fulfilled');
    if (manual && recovered) { state.recovery = false; state.recoveryFor = null; hideError(); toast('State refreshed. Review the latest records before another action.'); }
    state.reading = false; els.loading.hidden = true; $('dashboard').setAttribute('aria-busy', 'false'); setControlsDisabled(false); scheduleDashboardPoll(); scheduleFullPoll();
  }
  async function mutate(path, payload, kind, message, onSuccess) {
    if (state.busy || state.recovery || !state.active || !permitted(kind)) return;
    const generation = invalidate(); state.busy = true; setControlsDisabled(true); hideError();
    try {
      const data = await api(path, { method: 'POST', ...(payload == null ? {} : { body: JSON.stringify(payload) }) });
      if (generation !== state.generation || !state.active) return;
      if (onSuccess) onSuccess(data);
      toast(message);
    } catch (error) {
      if (generation !== state.generation || !state.active) return;
      state.recovery = !!error.ambiguous;
      state.recoveryFor = path.includes('/alerts/') ? 'alerts' : path.includes('/monitoring/') ? 'monitoring' : 'state';
      showError(error.ambiguous ? 'Outcome uncertain — refresh before retrying' : 'Action was rejected', `${error.message}${error.ambiguous ? ' The server may have applied this action. Refresh state and inspect the records before retrying; it will not be repeated automatically.' : ''}`);
      if (error.ambiguous) connection(false, 'Action outcome uncertain · last known data retained · refresh state to recover');
    } finally {
      if (generation === state.generation && state.active) { state.busy = false; setControlsDisabled(false); if (!state.recovery) await refreshAll(); }
    }
  }
  function sendSmsReply(clinicId, reply) {
    return mutate('/api/sms/reply', { clinic_id: clinicId, reply }, 'clinic', `Simulated SMS reply ${reply} recorded.`, (data) => {
      if (!Array.isArray(data.clinics) || !Array.isArray(data.feeders)) { const error = new Error('SMS reply response could not be verified.'); error.ambiguous = true; throw error; }
      const receivedAt = new Date().toISOString(); state.received = receivedAt; state.stateStale = false; renderState(data, receivedAt); renderTelemetry(data);
    });
  }
  function performAction(action, extra) {
    if (action === 'reset' && state.live && state.live.telemetry_mode === 'external' && !window.confirm('Switch from external telemetry to synthetic simulation? Active external readings will be replaced. Stored history is retained. Do not use this during operational monitoring.')) return;
    const kind = ['trip_feeder', 'restore_feeder'].includes(action) ? 'feeder' : ['local_fault', 'restore_clinic', 'freeze_clinic'].includes(action) ? 'clinic' : 'write';
    return mutate('/api/simulate', { action, ...(extra || {}) }, kind, 'Simulation action recorded.', (data) => {
      if (!Array.isArray(data.clinics) || !Array.isArray(data.feeders)) { const error = new Error('Simulation response could not be verified.'); error.ambiguous = true; throw error; }
      const receivedAt = new Date().toISOString(); state.received = receivedAt; state.stateStale = false; renderState(data, receivedAt); renderTelemetry(data);
    });
  }

  $('tripFeeder').addEventListener('click', () => performAction('trip_feeder', { feeder_id: Number(els.feederSelect.value) }));
  $('restoreFeeder').addEventListener('click', () => performAction('restore_feeder', { feeder_id: Number(els.feederSelect.value) }));
  $('localFault').addEventListener('click', () => performAction('local_fault', { clinic_id: els.clinicSelect.value }));
  $('restoreClinic').addEventListener('click', () => performAction('restore_clinic', { clinic_id: els.clinicSelect.value }));
  $('freezeClinic').addEventListener('click', () => performAction('freeze_clinic', { clinic_id: els.clinicSelect.value }));
  $('advance1').addEventListener('click', () => performAction('advance', { hours: 1 })); $('advance6').addEventListener('click', () => performAction('advance', { hours: 6 })); $('resetSimulation').addEventListener('click', () => performAction('reset'));
   els.tableBody.addEventListener('click', (event) => {
     const button = event.target.closest('[data-sms-reply]');
     if (!button || button.disabled) return;
     sendSmsReply(button.dataset.clinicId, button.dataset.smsReply);
   });
   els.search.addEventListener('input', () => state.live && renderTable(state.live)); els.riskFilter.addEventListener('change', () => state.live && renderTable(state.live)); els.feederFilter.addEventListener('change', () => state.live && renderTable(state.live)); els.clinicSelect.addEventListener('change', () => state.live && renderPowerCutForecast(state.live)); $('dismissError').addEventListener('click', hideError); els.alarmSoundButton.addEventListener('pointerdown', primeAlarmAudio, { passive: true }); els.alarmSoundButton.addEventListener('touchstart', primeAlarmAudio, { passive: true }); els.alarmSoundButton.addEventListener('click', toggleAlarmSound);
   ['authoritySearch', 'authorityLocationFilter'].forEach((id) => { if ($(id)) $(id).addEventListener('change', () => loadAuthority(state.generation).catch(() => {})); });
   ['authorityStatusFilter', 'authorityRiskFilter'].forEach((id) => { if ($(id)) $(id).addEventListener('change', () => loadAuthority(state.generation).catch(() => {})); });
   if (els.authorityClinicBody) els.authorityClinicBody.addEventListener('click', (event) => { const button = event.target.closest('[data-authority-open]'); if (button) openAuthorityClinic(button.dataset.authorityOpen).catch((error) => showError('Clinic detail unavailable', error.message)); });
   if ($('authorityRefresh')) $('authorityRefresh').addEventListener('click', () => loadAuthority(state.generation).catch((error) => showError('Authority refresh failed', error.message)));
   if ($('authorityRegisterToggle')) $('authorityRegisterToggle').addEventListener('click', () => { if ($('authorityRegisterForm')) $('authorityRegisterForm').hidden = !$('authorityRegisterForm').hidden; });
   if ($('authorityRegisterCancel')) $('authorityRegisterCancel').addEventListener('click', () => { $('authorityRegisterForm').hidden = true; $('authorityRegisterForm').reset(); });
   if ($('authorityRegisterForm')) $('authorityRegisterForm').addEventListener('submit', async (event) => { event.preventDefault(); if (!event.currentTarget.reportValidity()) return; const status = $('authorityRegisterStatus'); const button = event.currentTarget.querySelector('button[type="submit"]'); button.disabled = true; status.textContent = 'Registering…'; try { await api('/api/authority/clinics', { method: 'POST', body: JSON.stringify({ clinic_id: $('authorityRegisterId').value.trim().toUpperCase(), name: $('authorityRegisterName').value.trim(), location: $('authorityRegisterLocation').value.trim(), active: true }) }); status.textContent = 'Clinic registered.'; event.currentTarget.reset(); await loadAuthority(state.generation); } catch (error) { status.textContent = `Registration failed: ${error.message}`; } finally { button.disabled = false; } });
   if ($('authorityCloseDetail')) $('authorityCloseDetail').addEventListener('click', () => { if (els.authorityClinicDetail) els.authorityClinicDetail.hidden = true; authorityClinicId = null; });
   if (els.authorityFollowupForm) els.authorityFollowupForm.addEventListener('submit', async (event) => { event.preventDefault(); if (!authorityClinicId || !els.authorityFollowupMessage.value.trim()) return; const button = event.currentTarget.querySelector('button[type="submit"]'); button.disabled = true; try { await api(`/api/authority/clinics/${encodeURIComponent(authorityClinicId)}/followups`, { method: 'POST', body: JSON.stringify({ message: els.authorityFollowupMessage.value.trim() }) }); els.authorityFollowupMessage.value = ''; els.authorityFollowupStatus.textContent = 'Simulated follow-up request recorded.'; await loadAuthority(state.generation); await openAuthorityClinic(authorityClinicId); } catch (error) { els.authorityFollowupStatus.textContent = `Request failed: ${error.message}`; } finally { button.disabled = false; } });
  window.addEventListener('resize', () => { if (state.live) renderPowerCutForecast(state.live); if (state.model && !els.modelContent.hidden) { drawChart($('reliabilityChart'), state.model.calibration, '#38d6c3', 'Reliability curve: observed outcome versus predicted probability'); drawChart($('rocChart'), state.model.roc_curve, '#f5a35b', 'ROC curve: true positive rate versus false positive rate'); } });
  $('alertsList').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-ack]');
    if (!button || button.disabled) return;
    button.textContent = 'Recording…';
    await mutate(`/api/alerts/${encodeURIComponent(button.dataset.ack)}/acknowledge`, null, 'write', 'Acknowledgement recorded in the demo log.', (data) => {
      if (!data.alert || !data.alert.acknowledged_by) { const error = new Error('Acknowledgement response could not be verified.'); error.ambiguous = true; throw error; }
      button.dataset.done = 'true'; button.textContent = 'Acknowledgement recorded';
    });
    if (button.isConnected) button.textContent = state.recovery ? 'Refresh to verify' : button.dataset.done === 'true' ? 'Acknowledgement recorded' : 'Acknowledge';
  });
  $('feedbackForm').addEventListener('submit', (event) => {
    event.preventDefault(); if (!$('feedbackForm').reportValidity()) return;
    const predictionId = $('predictionSelect').value; const actualOutcome = $('actualOutcome').value === 'true';
    mutate('/api/monitoring/feedback', { prediction_id: /^\d+$/.test(predictionId) ? Number(predictionId) : predictionId, actual_outcome: actualOutcome, notes: $('feedbackNotes').value.trim() }, 'feedback', 'Human-confirmed outcome recorded.', (data) => {
      if (data.id == null || String(data.prediction_id) !== predictionId || data.actual_outcome !== actualOutcome) { const error = new Error('Feedback response could not be verified.'); error.ambiguous = true; throw error; }
      $('actualOutcome').value = ''; $('feedbackNotes').value = ''; $('feedbackStatus').textContent = `Outcome recorded for prediction #${predictionId}.`;
    });
  });
  $('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault(); if (!$('loginForm').reportValidity()) return;
    const generation = invalidate(); $('loginButton').disabled = true; $('demoEnter').disabled = true; $('authStatus').textContent = 'Signing in…';
    try {
      const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: $('username').value.trim(), password: $('password').value }) });
      if (generation !== state.generation) return;
      if (typeof data.access_token !== 'string' || !data.access_token || !finite(data.expires_in) || Number(data.expires_in) <= 0) throw new Error('The server returned an invalid session.');
      enterSession(data.user, data.access_token, data.expires_in);
    } catch (error) { if (generation === state.generation) $('authStatus').textContent = `Sign-in unsuccessful. ${error.message}`; }
    finally { if (generation === state.generation) { $('password').value = ''; $('loginButton').disabled = false; $('demoEnter').disabled = false; } }
  });
  $('logoutButton').addEventListener('click', () => { lockSession('Signed out. Sign in or explicitly re-enter the local demo.'); $('username').focus(); });
  $('optionalSignIn').addEventListener('click', () => { lockSession('Sign in with an account, or return to the local demo.'); $('username').focus(); });
  $('demoEnter').addEventListener('click', enterDemo); $('retryAuth').addEventListener('click', configureAuth);
  $('refreshButton').addEventListener('click', () => refreshAll(true));
  window.addEventListener('pagehide', disposeAlarmAudio);
  window.addEventListener('beforeunload', disposeAlarmAudio);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(state.pollTimer); clearTimeout(state.fullPollTimer); }
    else if (state.active && !state.recovery) refreshAll();
  });
  const unknown = document.createElement('option'); unknown.value = 'Unknown'; unknown.textContent = 'Unknown'; els.riskFilter.append(unknown);
  const scrollTable = document.querySelector('.table-scroll'); scrollTable.tabIndex = 0; scrollTable.setAttribute('role', 'region'); scrollTable.setAttribute('aria-label', 'Clinic register. Scroll horizontally to see all columns.');
  document.querySelector('.table-scroll th:last-child').textContent = 'Risk / observed safeguards';
  const links = Array.from(document.querySelectorAll('.section-nav a'));
  function selectNav(id) { links.forEach((link) => { if (link.hash === `#${id}`) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current'); }); }
  links.forEach((link) => link.addEventListener('click', () => selectNav(link.hash.slice(1))));
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => { const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top); if (visible.length) selectNav(visible[0].target.id); }, { rootMargin: '-15% 0px -55% 0px' });
    ['overview', 'operations', 'insights', 'readiness'].forEach((id) => observer.observe($(id)));
  }
  setControlsDisabled(true); configureAuth();
}());
