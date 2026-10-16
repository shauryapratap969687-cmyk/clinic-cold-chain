(function () {
  'use strict';

  const monitor = document.getElementById('coldchain-monitor');
  if (!monitor || window.ColdChainMonitor) return;

  const POLL_MS = 3000;
  const HOT_THRESHOLD_C = 6;
  const COLD_THRESHOLD_C = 2;
  const $ = (id) => document.getElementById(id);
  const els = {
    alarmBanner: $('cc-alarm-banner'), alarmTitle: $('cc-alarm-title'), alarmDetail: $('cc-alarm-detail'),
    networkHealth: $('cc-network-health'), networkDetail: $('cc-network-detail'),
    clinicsOnline: $('cc-clinics-online'), clinicsTotal: $('cc-clinics-total'), clinicsDetail: $('cc-clinics-detail'),
    thresholdDetail: $('cc-threshold-detail'), lastUpdate: $('cc-last-update'), refreshDetail: $('cc-refresh-detail'),
    connectionDot: $('cc-connection-dot'), connectionLabel: $('cc-connection-label'), connectionDetail: $('cc-connection-detail'),
    actionStatus: $('cc-action-status'), soundStatus: $('cc-sound-status'), soundToggle: $('cc-sound-toggle'),
    clinicCount: $('cc-clinic-count'), clinicGrid: $('cc-clinic-grid'),
    tripFeeder: $('cc-trip-feeder'), advance1: $('cc-advance-1'), advance6: $('cc-advance-6'), reset: $('cc-reset')
  };
  const actionControls = [els.tripFeeder, els.advance1, els.advance6, els.reset].filter(Boolean);
  const state = {
    data: null,
    lastReceivedAt: null,
    inFlight: false,
    actionBusy: false,
    pollTimer: null,
    requestController: null,
    alarmStates: new Map(),
    audioContext: null,
    soundSupported: null,
    soundUnlocked: false,
    soundMuted: false,
    destroyed: false,
    intersectionKnown: 'IntersectionObserver' in window,
    intersecting: !('IntersectionObserver' in window),
    visible: !('IntersectionObserver' in window)
  };

  function finite(value) {
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[character]));
  }

  function readable(value, fallback) {
    return value === null || value === undefined || value === '' ? (fallback || 'Unavailable') : String(value);
  }

  function formatTemperature(value) {
    return finite(value) ? `${Number(value).toFixed(1)}°C` : '—';
  }

  function localTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  function hotThreshold(clinic) {
    return clinic && finite(clinic.temperature_alarm_threshold_c)
      ? Number(clinic.temperature_alarm_threshold_c)
      : HOT_THRESHOLD_C;
  }

  function thresholdLabel(clinic) {
    const value = hotThreshold(clinic);
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }

  function temperatureAlarm(clinic) {
    const quality = clinic && clinic.data_quality;
    if (quality && quality !== 'ok') return false;
    return clinic && (clinic.temperature_alarm === true || String(clinic.temperature_alarm).toLowerCase() === 'true' ||
      (finite(clinic.temperature_c) && Number(clinic.temperature_c) > hotThreshold(clinic)));
  }

  function tooCold(clinic) {
    return clinic && (clinic.too_cold === true || (finite(clinic.temperature_c) && Number(clinic.temperature_c) < COLD_THRESHOLD_C));
  }

  function riskClass(value) {
    const normalized = String(value || 'unknown').toLowerCase();
    if (normalized === 'safe' || normalized === 'healthy' || normalized === 'low') return 'safe';
    if (normalized === 'warning' || normalized === 'medium') return 'warning';
    if (normalized === 'critical' || normalized === 'high') return 'critical';
    return 'unknown';
  }

  function errorMessage(payload, status) {
    const detail = payload && (payload.detail || payload.message || payload.error);
    if (Array.isArray(detail)) {
      return detail.map((item) => typeof item === 'string' ? item : item && (item.msg || item.message) || JSON.stringify(item)).join('; ');
    }
    if (detail && typeof detail === 'object') return detail.message || JSON.stringify(detail);
    return detail ? String(detail) : `Request failed (${status || 'unknown error'})`;
  }

  function friendlyError(error) {
    if (!error) return 'Unknown API error.';
    if (error.name === 'AbortError') return 'The API request timed out.';
    if (error.status === 401) return 'API authorization is required.';
    if (error.status === 403) return 'This account is not allowed to use that control.';
    if (error instanceof TypeError || /failed to fetch|network/i.test(error.message || '')) return 'The API is offline or unreachable.';
    return error.message || 'The API returned an error.';
  }

  async function request(path, options) {
    const requestOptions = { ...(options || {}), cache: 'no-store' };
    requestOptions.headers = {
      Accept: 'application/json',
      ...(requestOptions.body ? { 'Content-Type': 'application/json' } : {}),
      ...(requestOptions.headers || {})
    };
    const controller = typeof window.AbortController === 'function' ? new window.AbortController() : null;
    if (controller) {
      requestOptions.signal = controller.signal;
      state.requestController = controller;
    }
    const timeout = window.setTimeout(() => { if (controller) controller.abort(); }, requestOptions.method === 'POST' ? 15000 : 10000);
    try {
      const response = await window.fetch(path, requestOptions);
      let payload = null;
      try { payload = await response.json(); } catch (error) {
        if (response.ok) throw new Error('The API returned invalid JSON.');
      }
      if (!response.ok) {
        const failure = new Error(errorMessage(payload, response.status));
        failure.status = response.status;
        throw failure;
      }
      return payload;
    } finally {
      window.clearTimeout(timeout);
      if (state.requestController === controller) state.requestController = null;
    }
  }

  function statePayload(payload) {
    const candidate = payload && payload.state && typeof payload.state === 'object' ? payload.state : payload;
    if (!candidate || !Array.isArray(candidate.clinics) || !Array.isArray(candidate.feeders)) {
      throw new Error('The API response did not include clinic and feeder state.');
    }
    return candidate;
  }

  function setConnection(kind, label, detail) {
    els.connectionDot.className = `cc-connection-dot ${kind}`;
    els.connectionLabel.textContent = label;
    els.connectionDetail.textContent = detail;
  }

  function setActionStatus(message, isError) {
    els.actionStatus.textContent = message;
    els.actionStatus.className = isError ? 'is-error' : '';
  }

  function setSoundStatus(message, isError) {
    els.soundStatus.textContent = message;
    els.soundStatus.className = isError ? 'is-error' : '';
  }

  function updateSoundUi() {
    if (state.soundSupported === false) {
      els.soundToggle.textContent = 'Alarm sound unavailable';
      els.soundToggle.setAttribute('aria-pressed', 'false');
      setSoundStatus('Sound unavailable · visual alarms remain on', true);
      return;
    }
    if (state.soundUnlocked && !state.soundMuted) {
      els.soundToggle.textContent = 'Mute alarm sound';
      els.soundToggle.setAttribute('aria-pressed', 'true');
      setSoundStatus('Sound enabled · double beep on new alarms');
    } else if (state.soundUnlocked) {
      els.soundToggle.textContent = 'Enable alarm sound';
      els.soundToggle.setAttribute('aria-pressed', 'false');
      setSoundStatus('Sound muted · visual alarms remain on');
    } else {
      els.soundToggle.textContent = 'Enable alarm sound';
      els.soundToggle.setAttribute('aria-pressed', 'false');
      setSoundStatus('Sound locked · visual alarms remain on');
    }
  }

  function updateControls() {
    const hasState = !!state.data;
    const simulationMode = !hasState || state.data.telemetry_mode !== 'external';
    const locked = state.inFlight || state.actionBusy || !hasState;
    els.tripFeeder.disabled = locked || !simulationMode;
    els.advance1.disabled = locked || !simulationMode;
    els.advance6.disabled = locked || !simulationMode;
    els.reset.disabled = locked;
    const title = !hasState ? 'Waiting for live state.' : !simulationMode ? 'External telemetry is active; reset to return to simulation.' : '';
    actionControls.forEach((control) => { control.title = title; });
  }

  function feederById(data, feederId) {
    return data.feeders.find((feeder) => Number(feeder.id) === Number(feederId));
  }

  function renderSummary(data, clinics, hotClinics, coldClinics) {
    const summary = data.summary || {};
    const powered = finite(summary.powered_clinics) ? Number(summary.powered_clinics) : clinics.filter((clinic) => clinic.power_on === true).length;
    const total = finite(summary.total_clinics) ? Number(summary.total_clinics) : clinics.length;
    const activeFeeders = finite(summary.active_feeders) ? Number(summary.active_feeders) : data.feeders.filter((feeder) => feeder.online === true).length;
    const totalFeeders = finite(summary.total_feeders) ? Number(summary.total_feeders) : data.feeders.length;
    const health = readable(summary.system_health || data.telemetry_status, 'Unknown');
    const healthKind = riskClass(health);
    els.networkHealth.textContent = health;
    els.networkHealth.className = `cc-health-value ${healthKind}`;
    els.networkDetail.textContent = `${activeFeeders} / ${totalFeeders} feeders online · ${data.telemetry_mode === 'external' ? 'external telemetry' : 'simulation'}`;
    els.clinicsOnline.textContent = String(powered);
    els.clinicsTotal.textContent = String(total || clinics.length || 20);
    els.clinicsDetail.textContent = `${hotClinics.length} temp alarm${hotClinics.length === 1 ? '' : 's'} · ${coldClinics.length} too cold`;
    const threshold = hotClinics.length ? thresholdLabel(hotClinics[0]) : thresholdLabel(null);
    els.thresholdDetail.textContent = `${hotClinics.length} above ${threshold}°C · ${coldClinics.length} below 2°C`;
    els.lastUpdate.textContent = localTime(data.timestamp);
    els.refreshDetail.textContent = `Received ${localTime(state.lastReceivedAt)} · ${data.telemetry_status || 'Telemetry status unknown'}`;
  }

  function renderAlarmBanner(hotClinics, coldClinics) {
    if (!hotClinics.length && !coldClinics.length) {
      els.alarmBanner.hidden = true;
      return;
    }
    const hotNames = hotClinics.map((clinic) => `${readable(clinic.name, clinic.id)} (${formatTemperature(clinic.temperature_c)})`);
    const coldNames = coldClinics.map((clinic) => `${readable(clinic.name, clinic.id)} (${formatTemperature(clinic.temperature_c)})`);
    if (hotClinics.length) {
      els.alarmTitle.textContent = `${hotClinics.length} temperature alarm${hotClinics.length === 1 ? '' : 's'} · >${thresholdLabel(hotClinics[0])}°C`;
      els.alarmDetail.textContent = hotNames.join(' · ') + (coldNames.length ? ` · Too cold: ${coldNames.join(' · ')}` : '');
    } else {
      els.alarmTitle.textContent = `${coldClinics.length} too-cold warning${coldClinics.length === 1 ? '' : 's'} · below 2°C`;
      els.alarmDetail.textContent = coldNames.join(' · ');
    }
    els.alarmBanner.hidden = false;
  }

  function clinicMarkup(clinic, data) {
    const hot = temperatureAlarm(clinic);
    const cold = tooCold(clinic);
    const risk = readable(clinic.risk_level, 'Unknown');
    const riskKind = riskClass(risk);
    const power = clinic.power_on === true ? 'Online' : clinic.power_on === false ? 'Offline' : 'Unknown';
    const feeder = feederById(data, clinic.feeder_id);
    const feederState = feeder && feeder.online === true ? 'online' : feeder && feeder.online === false ? 'offline' : 'unknown';
    const quality = readable(clinic.data_quality, 'unknown');
    const badges = [];
    if (hot) badges.push(`<span class="cc-state-badge cc-badge-alarm">Temp alarm &gt;${thresholdLabel(clinic)}°C</span>`);
    if (cold) badges.push('<span class="cc-state-badge cc-badge-cold">Too cold &lt;2°C</span>');
    if (!badges.length) badges.push('<span class="cc-state-badge cc-badge-ok">Temperature in range</span>');
    return `<article class="cc-clinic-card${hot ? ' is-alarm' : ''}${cold ? ' is-too-cold' : ''}" role="listitem" data-clinic-id="${escapeHtml(clinic.id)}">
      <div class="cc-card-topline"><span class="cc-clinic-id">${escapeHtml(readable(clinic.id, 'Clinic'))}</span><span class="cc-quality">${escapeHtml(quality)}</span></div>
      <div class="cc-card-title"><h4>${escapeHtml(readable(clinic.name, clinic.id))}</h4><span class="cc-risk-pill ${riskKind}">${escapeHtml(risk)}</span></div>
      <div class="cc-temperature-readout"><span class="cc-temperature ${hot ? 'hot' : cold ? 'cold' : ''}">${formatTemperature(clinic.temperature_c)}</span><span class="cc-temperature-caption">current temperature</span></div>
      <div class="cc-badge-row">${badges.join('')}</div>
      <dl class="cc-clinic-details">
        <div><dt>Power</dt><dd class="cc-power ${power.toLowerCase()}"><i></i>${escapeHtml(power)}</dd></div>
        <div><dt>Feeder</dt><dd><span class="cc-feeder-dot ${feederState}"></span>Feeder ${escapeHtml(readable(clinic.feeder_id, '—'))}</dd></div>
        <div><dt>Temp alarm</dt><dd class="cc-flag ${hot ? 'active' : ''}">${hot ? `Yes · >${thresholdLabel(clinic)}°C` : 'No'}</dd></div>
        <div><dt>Too cold</dt><dd class="cc-flag ${cold ? 'active cold' : ''}">${cold ? 'Yes · &lt;2°C' : 'No'}</dd></div>
        <div><dt>Status</dt><dd>${escapeHtml(readable(clinic.status, 'Unknown'))}</dd></div>
        <div><dt>Risk / status</dt><dd>${escapeHtml(risk)} · ${escapeHtml(readable(clinic.status, 'Unknown'))}</dd></div>
      </dl>
      <div class="cc-card-footer"><span>Observed ${escapeHtml(localTime(clinic.observed_at))}</span><span>${escapeHtml(readable(clinic.source, 'source unavailable'))}</span></div>
    </article>`;
  }

  function renderClinics(data, clinics, hotClinics, coldClinics) {
    els.clinicCount.textContent = `${clinics.length} / 20 clinics · ${hotClinics.length} alarm${hotClinics.length === 1 ? '' : 's'}`;
    if (!clinics.length) {
      els.clinicGrid.innerHTML = '<div class="cc-empty-state">The API returned no clinic rows. Waiting for the next telemetry refresh…</div>';
      return;
    }
    els.clinicGrid.innerHTML = clinics.map((clinic) => clinicMarkup(clinic, data)).join('');
  }

  function playDoubleBeep() {
    if (!state.soundUnlocked || state.soundMuted || !state.audioContext || state.audioContext.state === 'suspended') return;
    try {
      const context = state.audioContext;
      const start = context.currentTime;
      [0, 0.18].forEach((offset) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(880, start + offset);
        gain.gain.setValueAtTime(0.0001, start + offset);
        gain.gain.exponentialRampToValueAtTime(0.16, start + offset + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.11);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(start + offset);
        oscillator.stop(start + offset + 0.12);
      });
    } catch (_) {
      // A blocked or incomplete audio implementation must never remove the visual alarm.
    }
  }

  function renderData(data) {
    const clinics = data.clinics;
    const hotClinics = clinics.filter(temperatureAlarm);
    const coldClinics = clinics.filter(tooCold);
    const nextAlarmStates = new Map(clinics.map((clinic) => [String(clinic.id), temperatureAlarm(clinic)]));
    const newlyAlarmed = clinics.filter((clinic) => temperatureAlarm(clinic) && state.alarmStates.get(String(clinic.id)) !== true);
    state.alarmStates = nextAlarmStates;
    state.data = data;
    renderSummary(data, clinics, hotClinics, coldClinics);
    renderAlarmBanner(hotClinics, coldClinics);
    renderClinics(data, clinics, hotClinics, coldClinics);
    updateControls();
    newlyAlarmed.forEach(() => playDoubleBeep());
  }

  function schedulePoll() {
    window.clearTimeout(state.pollTimer);
    state.pollTimer = null;
    if (!state.destroyed && state.visible && !state.inFlight && !state.actionBusy) {
      state.pollTimer = window.setTimeout(() => { state.pollTimer = null; refresh(); }, POLL_MS);
    }
  }

  async function refresh() {
    if (state.destroyed || !state.visible || document.hidden || state.inFlight || state.actionBusy) return;
    state.inFlight = true;
    updateControls();
    if (!state.data) setConnection('waiting', 'Connecting to API', 'Reading GET /api/state…');
    try {
      const data = statePayload(await request('/api/state'));
      state.lastReceivedAt = new Date().toISOString();
      renderData(data);
      setConnection('connected', 'Connected · live state', `Polling every 3 seconds · received ${localTime(state.lastReceivedAt)}`);
      if (!state.actionBusy) setActionStatus('Live state received. Simulation controls are ready.');
    } catch (error) {
      const message = friendlyError(error);
      const retained = state.data ? `Last known state retained · ${localTime(state.data.timestamp)}` : 'No live state available yet.';
      setConnection('error', error.status === 401 ? 'Authorization required' : 'API unavailable', `${message} ${retained}`);
      if (!state.data) setActionStatus(`${message} The monitor will retry automatically.`, true);
    } finally {
      state.inFlight = false;
      updateControls();
      schedulePoll();
    }
  }

  async function simulate(action, label, extra) {
    if (state.actionBusy || state.inFlight || !state.data) return;
    state.actionBusy = true;
    updateControls();
    setActionStatus(`${label}…`);
    try {
      const payload = { action, ...(extra || {}) };
      const data = statePayload(await request('/api/simulate', { method: 'POST', body: JSON.stringify(payload) }));
      state.lastReceivedAt = new Date().toISOString();
      renderData(data);
      setConnection('connected', 'Connected · live state', `Simulation action applied · received ${localTime(state.lastReceivedAt)}`);
      setActionStatus(`${label} applied. State refreshed.`);
    } catch (error) {
      const message = friendlyError(error);
      const retained = state.data ? `Last known state retained · ${localTime(state.data.timestamp)}` : 'No state available.';
      setConnection('error', error.status === 401 ? 'Authorization required' : 'Action unavailable', `${message} ${retained}`);
      setActionStatus(`${label} failed · ${message}`, true);
    } finally {
      state.actionBusy = false;
      updateControls();
      schedulePoll();
    }
  }

  async function toggleSound() {
    if (state.soundUnlocked && !state.soundMuted) {
      state.soundMuted = true;
      updateSoundUi();
      return;
    }
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (typeof AudioContext !== 'function') {
      state.soundSupported = false;
      updateSoundUi();
      return;
    }
    try {
      if (!state.audioContext) state.audioContext = new AudioContext();
      if (state.audioContext.resume) await state.audioContext.resume();
      if (state.audioContext.state === 'suspended') throw new Error('AudioContext is still suspended');
      state.soundSupported = true;
      state.soundUnlocked = true;
      state.soundMuted = false;
      updateSoundUi();
      // If the operator enables sound after an alarm is already visible, play
      // one confirmation double-beep so the control can be tested without
      // waiting for another threshold crossing.
      if (state.data && Array.isArray(state.data.clinics) && state.data.clinics.some(temperatureAlarm)) {
        playDoubleBeep();
      }
    } catch (_) {
      state.soundSupported = false;
      state.soundUnlocked = false;
      updateSoundUi();
    }
  }

  function updatePollingVisibility() {
    const nextVisible = state.intersecting && !document.hidden;
    if (state.visible !== nextVisible) {
      state.visible = nextVisible;
      if (!nextVisible) {
        window.clearTimeout(state.pollTimer);
        state.pollTimer = null;
      } else {
        refresh();
      }
    } else if (nextVisible && !state.pollTimer && !state.inFlight && !state.actionBusy) {
      refresh();
    }
  }

  function fallbackVisibility() {
    if (state.intersectionKnown) return;
    const rect = monitor.getBoundingClientRect();
    const hasLayout = rect.width > 0 || rect.height > 0;
    state.intersecting = !hasLayout || (rect.bottom > 0 && rect.top < (window.innerHeight || document.documentElement.clientHeight));
    updatePollingVisibility();
  }

  function destroy() {
    state.destroyed = true;
    window.clearTimeout(state.pollTimer);
    if (state.requestController) state.requestController.abort();
    if (state.observer) state.observer.disconnect();
  }

  els.tripFeeder.addEventListener('click', () => simulate('trip_feeder', 'Trip feeder 3', { feeder_id: 3 }));
  els.advance1.addEventListener('click', () => simulate('advance', 'Advance 1 hour', { hours: 1 }));
  els.advance6.addEventListener('click', () => simulate('advance', 'Advance 6 hours', { hours: 6 }));
  els.reset.addEventListener('click', () => simulate('reset', 'Reset simulation'));
  els.soundToggle.addEventListener('click', () => { toggleSound(); });
  document.addEventListener('visibilitychange', updatePollingVisibility);

  if (state.intersectionKnown) {
    state.observer = new window.IntersectionObserver((entries) => {
      const entry = entries.find((item) => item.target === monitor);
      if (!entry) return;
      state.intersecting = entry.isIntersecting || entry.intersectionRatio > 0;
      updatePollingVisibility();
    }, { threshold: 0.05 });
    state.observer.observe(monitor);
  } else {
    window.addEventListener('scroll', fallbackVisibility, { passive: true });
    window.addEventListener('resize', fallbackVisibility);
    fallbackVisibility();
  }

  updateSoundUi();
  updateControls();
  window.addEventListener('beforeunload', destroy, { once: true });
  window.ColdChainMonitor = {
    refresh,
    setVisible(value) { state.intersecting = !!value; updatePollingVisibility(); },
    destroy,
    getSnapshot() {
      return { data: state.data, visible: state.visible, soundUnlocked: state.soundUnlocked, soundMuted: state.soundMuted };
    }
  };
}());
