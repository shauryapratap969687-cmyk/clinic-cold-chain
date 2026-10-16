(function () {
  'use strict';

  const state = { live: null, model: null, busy: false, generation: 0, pollTimer: null, token: null, user: null, config: null, active: false, reading: false, reads: new Set(), expiryTimer: null, recovery: false, panels: {}, received: null };
  const $ = (id) => document.getElementById(id);
  const els = {
    loading: $('loadingState'), error: $('globalError'), errorTitle: $('errorTitle'), errorMessage: $('errorMessage'),
    simClock: $('simClock'), horizon: $('horizonValue'), lastSync: $('lastSync'), feederGrid: $('feederGrid'),
    feederSelect: $('feederSelect'), clinicSelect: $('clinicSelect'), feederFilter: $('feederFilter'), riskFilter: $('riskFilter'), search: $('clinicSearch'),
    tableBody: $('clinicTableBody'), tableSummary: $('tableSummary'), modelStatus: $('modelStatus'), modelUnavailable: $('modelUnavailable'), modelContent: $('modelContent')
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
  const permitted = (kind) => ({ feeder: ['admin', 'grid_operator'], clinic: ['admin', 'clinic_operator'], feedback: ['admin', 'clinic_operator'], audit: ['admin', 'auditor'], write: ['admin', 'clinic_operator', 'grid_operator'] }[kind] || []).includes(role());
  const riskClass = (value) => ({ safe: 'safe', healthy: 'safe', critical: 'critical', high: 'critical', warning: 'warning', medium: 'warning', low: 'safe' }[String(value).toLowerCase()] || 'unknown');
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
    document.querySelectorAll('[data-feedback-control]').forEach((control) => { control.disabled = locked || !permitted('feedback'); });
    $('refreshButton').disabled = state.busy || state.reading;
    $('busyNote').textContent = state.busy ? 'Saving action… please wait' : state.recovery ? 'Refresh state before retrying an action' : !permitted('write') ? 'Read-only role · operational writes disabled' : 'Actions are serialized · permissions enforced by server';
  }

  function feederName(id) {
    const feeder = state.live && state.live.feeders && state.live.feeders.find((item) => Number(item.id) === Number(id));
    return feeder ? feeder.name : `Feeder ${id}`;
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
    const health = Number(data.stale_sensor_count) > 0 && riskClass(reportedHealth) === 'safe' ? 'Unknown / stale' : reportedHealth; const healthClass = riskClass(health);
    $('systemHealth').textContent = health; $('healthSub').textContent = 'Risk posture from live state'; $('healthDot').className = `health-dot ${healthClass}`; $('healthTrack').parentElement.className = `health-track ${healthClass}`;
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

  function renderTable(data) {
    const clinics = Array.isArray(data.clinics) ? data.clinics : [];
    const query = els.search.value.trim().toLowerCase(); const risk = els.riskFilter.value; const feeder = els.feederFilter.value;
    const levelFor = (clinic) => clinic.data_quality && clinic.data_quality !== 'ok' ? 'Unknown' : clinic.too_cold || clinic.too_hot || (finite(clinic.temperature_c) && (Number(clinic.temperature_c) < 2 || Number(clinic.temperature_c) > 8)) ? 'Critical' : ['Safe', 'Warning', 'Critical'].includes(clinic.risk_level) ? clinic.risk_level : 'Unknown';
    const rows = clinics.filter((clinic) => (!query || `${clinic.id} ${clinic.name}`.toLowerCase().includes(query)) && (risk === 'all' || levelFor(clinic) === risk) && (feeder === 'all' || String(clinic.feeder_id) === feeder));
    els.tableBody.innerHTML = rows.length ? rows.map((clinic) => {
      const level = levelFor(clinic); const levelClass = riskClass(level); const power = clinic.power_on === true; const cold = clinic.too_cold || (finite(clinic.temperature_c) && Number(clinic.temperature_c) < 2); const hot = clinic.too_hot || (finite(clinic.temperature_c) && Number(clinic.temperature_c) > 8);
      const hazard = cold || hot ? `<span class="hazard-tag">${clinic.data_quality === 'ok' ? 'Observed' : 'Last known'}: ${cold ? 'too cold (<2°C)' : 'too hot (>8°C)'}</span>` : '';
      const powerLabel = clinic.data_quality && clinic.data_quality !== 'ok' ? 'Unknown / last known' : clinic.power_on == null ? 'Unknown' : power ? 'Online' : 'Offline';
      const status = clinic.status ? `<span class="clinic-id">${escapeHtml(clinic.status)}</span>` : '';
      return `<tr><td><span class="clinic-name">${escapeHtml(clinic.name)}</span><span class="clinic-id">${escapeHtml(clinic.id)}</span>${status}<span class="clinic-id">Source: ${escapeHtml(text(clinic.source || clinic.risk_source))} · Quality: ${escapeHtml(text(clinic.data_quality))}</span></td><td class="feeder-cell">${escapeHtml(feederName(clinic.feeder_id))}</td><td><span class="power-state ${power && clinic.data_quality === 'ok' ? '' : 'off'}"><i></i>${powerLabel}</span></td><td><span class="temp ${cold ? 'cold' : hot ? 'hot' : ''}">${formatNumber(clinic.temperature_c, 1)}${finite(clinic.temperature_c) ? '°C' : ''}</span>${hazard}</td><td><span class="weather"><span>☂ <b>${formatNumber(clinic.forecast_rain_next_6h, 1)} mm</b></span><span>≋ <b>${formatNumber(clinic.forecast_wind_next_6h, 1)} km/h</b></span></span></td><td><div class="risk-cell"><span class="risk-value">${percent(clinic.risk_probability)}</span><span class="badge ${levelClass}">${escapeHtml(level)}</span></div></td></tr>`;
    }).join('') : '<tr><td colspan="6" class="empty-cell">No clinics match the current filters.</td></tr>';
    els.tableSummary.textContent = `Showing ${rows.length} of ${clinics.length} clinics · Model probabilities appear only when available. Observed temperature violations elevate risk independently. Readings with stale quality are last known.`;
  }

  function renderState(data) {
    state.live = data; renderHeader(data); renderSummary(data); renderFeeders(data); renderSelects(data); renderTable(data);
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
    if (!data || data.ready !== true) { els.modelStatus.textContent = 'Rules-only / profile unavailable';els.modelStatus.className='model-status not-ready';els.modelUnavailable.textContent = 'Model profile is unavailable or not ready. Deterministic safeguards remain independent of model availability; missing predictions are not zero risk.';els.modelUnavailable.hidden=false;els.modelContent.hidden=true;return; }
    els.modelUnavailable.hidden = true; els.modelContent.hidden = false; els.modelStatus.textContent = data.model_name ? `${data.model_name} · ready` : 'Model ready'; els.modelStatus.className='model-status';
    const metrics = data.metrics || {}, dataset = data.dataset || {};
    $('modelName').textContent = data.model_name || '—'; $('modelHorizon').textContent = data.horizon_hours == null ? '—' : `${data.horizon_hours} hours`; $('datasetInfo').textContent = dataset.days == null ? '—' : `${dataset.days} days · ${dataset.rows || 0} rows`; $('positiveRate').textContent = percent(dataset.positive_rate);
    $('prAuc').textContent = formatNumber(metrics.pr_auc, 3); $('f2Score').textContent = formatNumber(metrics.f2, 3); $('brierScore').textContent = formatNumber(metrics.brier, 3); $('rocAuc').textContent = formatNumber(metrics.roc_auc, 3); $('threshold').textContent = percent(metrics.threshold, 1); $('prevalence').textContent = percent(metrics.prevalence, 1);
    const matrix = data.confusion_matrix || [[null, null], [null, null]]; $('matrixTn').textContent = matrix[0] && matrix[0][0] != null ? matrix[0][0] : '—'; $('matrixFp').textContent = matrix[0] && matrix[0][1] != null ? matrix[0][1] : '—'; $('matrixFn').textContent = matrix[1] && matrix[1][0] != null ? matrix[1][0] : '—'; $('matrixTp').textContent = matrix[1] && matrix[1][1] != null ? matrix[1][1] : '—';
    const importance = Array.isArray(data.feature_importance) ? data.feature_importance.slice().sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0)) : []; const maxImportance = Math.max(...importance.map((item) => finite(item.importance) ? Number(item.importance) : 0), 0); $('featureImportance').innerHTML = importance.length ? importance.map((item) => `<div class="importance-row"><span class="importance-label" title="${escapeHtml(item.feature)}">${escapeHtml(item.feature)}</span><span class="importance-bar"><span style="width:${maxImportance && finite(item.importance) ? Math.max(0, Math.min(100, Number(item.importance) / maxImportance * 100)) : 0}%"></span></span><span class="importance-value">${formatNumber(item.importance, 3)}</span></div>`).join('') : '<div class="empty-state">No feature importance data returned.</div>';
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
  const panels = { alerts: renderAlerts, weather: renderWeather, monitoring: renderMonitoring, policy: renderPolicy, audit: renderAudit };
  function toast(message) {
    $('toastRegion').replaceChildren();
    const notification = document.createElement('div'); notification.className = 'toast'; notification.textContent = message; $('toastRegion').append(notification);
    clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => notification.remove(), 6500);
  }
  function invalidate() {
    state.generation += 1; clearTimeout(state.pollTimer);
    state.reads.forEach((controller) => controller.abort()); state.reads.clear(); state.reading = false;
    return state.generation;
  }
  function connection(ok, message) {
    document.body.classList.toggle('disconnected', !ok);
    $('connectionStatus').textContent = message;
    $('connectionStatus').parentElement.classList.toggle('stale', !ok);
    if (!ok) {
      $('systemHealth').textContent = state.live ? 'Stale / disconnected' : 'Unknown';
      $('healthSub').textContent = state.live ? 'Retained values are last known, not live' : 'No current state available';
      $('healthDot').className = 'health-dot warning'; $('healthTrack').parentElement.className = 'health-track unknown';
      $('telemetryContent').innerHTML = '<span class="badge warning">Stale / unknown — state connection unavailable</span><p>Last-known readings must not be treated as current.</p>';
    }
  }
  function lockSession(message) {
    invalidate(); clearTimeout(state.expiryTimer); clearTimeout(state.toastTimer);
    state.token = null; state.user = null; state.active = false; state.busy = false; state.recovery = false; state.recoveryFor = null; state.received = null; state.panels = {};
    renderState({}); state.live = null; renderModel(null); state.model = null;
    ['alertsList', 'weatherContent', 'telemetryContent', 'monitoringContent', 'policyContent', 'auditContent', 'sessionIdentity', 'toastRegion', 'feedbackStatus', 'featureImportance'].forEach((id) => { $(id).replaceChildren(); });
    ['modelName', 'modelHorizon', 'datasetInfo', 'positiveRate', 'prAuc', 'f2Score', 'brierScore', 'rocAuc', 'threshold', 'prevalence', 'matrixTn', 'matrixFp', 'matrixFn', 'matrixTp'].forEach((id) => { $(id).textContent = '—'; });
    $('modelNotes').querySelector('ul').replaceChildren(); $('modelNotes').hidden = true; $('connectionStatus').textContent = 'Signed out';
    Object.keys(panels).forEach((name) => { $(`${name}Status`).textContent = 'Waiting for connection…'; $(`${name}Status`).className = 'panel-status'; });
    $('feedbackForm').reset(); $('feedbackForm').hidden = true; $('predictionSelect').replaceChildren(); $('clinicSearch').value = ''; $('riskFilter').value = 'all';
    ['reliabilityChart', 'rocChart'].forEach((id) => { const canvas = $(id); canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); });
    $('dashboard').hidden = true; $('sectionNav').hidden = true; $('auditSection').hidden = true;
    $('authPanel').hidden = false; $('authStatus').textContent = message; $('loginForm').hidden = !state.config; $('loginForm').reset();
    $('demoEnter').hidden = !isDemo(); $('retryAuth').hidden = !!state.config; $('loginButton').disabled = false; $('demoEnter').disabled = false;
    els.loading.hidden = true; hideError(); setControlsDisabled(false);
  }
  function isDemo() { return state.config && state.config.auth_mode === 'demo' && state.config.demo !== false; }
  function enterSession(user, token, expires) {
    if (!user || !['clinic_operator', 'grid_operator', 'admin', 'auditor'].includes(user.role)) throw new Error('The server returned an unsupported user role.');
    invalidate(); state.user = user; state.token = token || null; state.active = true; state.recovery = false;
    $('authPanel').hidden = true; $('dashboard').hidden = false; $('sectionNav').hidden = false;
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
  function schedulePoll() {
    clearTimeout(state.pollTimer);
    if (state.active && !document.hidden && !state.busy && !state.reading && !state.recovery) state.pollTimer = setTimeout(() => refreshAll(), 15000);
  }
  async function refreshAll(manual = false) {
    if (!state.active || state.busy || state.reading || document.hidden) return;
    clearTimeout(state.pollTimer); const generation = state.generation; state.reading = true; setControlsDisabled(false);
    els.loading.hidden = !!state.live; $('dashboard').setAttribute('aria-busy', 'true');
    let stateOk = false;
    try {
      const data = await api('/api/state');
      if (generation !== state.generation || !state.active) return;
      if (!Array.isArray(data.clinics) || !Array.isArray(data.feeders)) throw new Error('State response is missing clinics or feeders.');
      renderState(data); renderTelemetry(data); state.received = new Date().toISOString(); stateOk = true;
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
      const data = await api(`/api/${name}`);
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
    const recoveryIndex = names.indexOf(state.recoveryFor);
    const recovered = stateOk && (recoveryIndex < 0 || results[recoveryIndex].status === 'fulfilled');
    if (manual && recovered) { state.recovery = false; state.recoveryFor = null; hideError(); toast('State refreshed. Review the latest records before another action.'); }
    state.reading = false; els.loading.hidden = true; $('dashboard').setAttribute('aria-busy', 'false'); setControlsDisabled(false); schedulePoll();
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
  function performAction(action, extra) {
    if (action === 'reset' && state.live && state.live.telemetry_mode === 'external' && !window.confirm('Switch from external telemetry to synthetic simulation? Active external readings will be replaced. Stored history is retained. Do not use this during operational monitoring.')) return;
    const kind = ['trip_feeder', 'restore_feeder'].includes(action) ? 'feeder' : ['local_fault', 'restore_clinic', 'freeze_clinic'].includes(action) ? 'clinic' : 'write';
    return mutate('/api/simulate', { action, ...(extra || {}) }, kind, 'Simulation action recorded.', (data) => {
      if (!Array.isArray(data.clinics) || !Array.isArray(data.feeders)) { const error = new Error('Simulation response could not be verified.'); error.ambiguous = true; throw error; }
      renderState(data); renderTelemetry(data);
    });
  }

  $('tripFeeder').addEventListener('click', () => performAction('trip_feeder', { feeder_id: Number(els.feederSelect.value) }));
  $('restoreFeeder').addEventListener('click', () => performAction('restore_feeder', { feeder_id: Number(els.feederSelect.value) }));
  $('localFault').addEventListener('click', () => performAction('local_fault', { clinic_id: els.clinicSelect.value }));
  $('restoreClinic').addEventListener('click', () => performAction('restore_clinic', { clinic_id: els.clinicSelect.value }));
  $('freezeClinic').addEventListener('click', () => performAction('freeze_clinic', { clinic_id: els.clinicSelect.value }));
  $('advance1').addEventListener('click', () => performAction('advance', { hours: 1 })); $('advance6').addEventListener('click', () => performAction('advance', { hours: 6 })); $('resetSimulation').addEventListener('click', () => performAction('reset'));
  els.search.addEventListener('input', () => state.live && renderTable(state.live)); els.riskFilter.addEventListener('change', () => state.live && renderTable(state.live)); els.feederFilter.addEventListener('change', () => state.live && renderTable(state.live)); $('dismissError').addEventListener('click', hideError);
  window.addEventListener('resize', () => { if (state.model && !els.modelContent.hidden) { drawChart($('reliabilityChart'), state.model.calibration, '#38d6c3', 'Reliability curve: observed outcome versus predicted probability'); drawChart($('rocChart'), state.model.roc_curve, '#f5a35b', 'ROC curve: true positive rate versus false positive rate'); } });
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
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(state.pollTimer); }
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
    ['overview', 'operations', 'insights', 'readiness'].map((id) => $(id)).filter(Boolean).forEach((section) => observer.observe(section));
  }
  setControlsDisabled(true); configureAuth();
}());

/* CodeFlow visual lesson. This layer is intentionally self-contained so the
   original synthetic API smoke tests can keep their hidden compatibility DOM. */
(function () {
  'use strict';
  if (window.CodeFlowModernUI) return;
  const codeLines = [
    'numbers = [2, 7, 11, 15]',
    'target = 9',
    'total = 0',
    'for i in range(4):',
    '    total = total + numbers[i]',
    'print(total)',
  ];
  const defaultSource = codeLines.join('\n');
  const steps = [
    { line: 1, title: 'The numbers are ready.', hint: 'Making the input list', vars: { numbers: '[2, 7, 11, 15]' }, map: [], array: 0, caption: 'We make a list of four numbers. A list keeps items in order.', what: 'This line makes an array. An array is a row of items kept in order.', changed: 'numbers: empty → [2, 7, 11, 15]. The four numbers now have places.', why: 'The program needs numbers to search before it can find a pair.', next: 'Next, the program chooses the number it wants to add up to.', recap: 'The input is now four numbers: 2, 7, 11, and 15.' },
    { line: 2, title: 'The target is 9.', hint: 'Setting the answer we want', vars: { numbers: '[2, 7, 11, 15]', target: '9' }, map: [], array: 0, caption: 'The target is the total we are trying to make.', what: 'This line stores the total we want to find.', changed: 'target: empty → 9. The goal is now clear.', why: 'The program needs a finish line so it knows when a pair is correct.', next: 'Next, it makes an empty lookup map.', recap: 'The target is 9, so we are looking for two numbers that add to 9.' },
    { line: 3, title: 'The lookup box is empty.', hint: 'Creating a place to remember', vars: { numbers: '[2, 7, 11, 15]', target: '9', seen: '{}' }, map: [], array: 0, caption: 'seen is an empty map. It will remember numbers we already passed.', what: 'This line creates a map called seen. A map stores a value beside a label.', changed: 'seen: empty → {}. It has no remembered numbers yet.', why: 'Remembering old numbers lets us find a pair in one pass instead of checking every pair.', next: 'The loop is ready. It will check 4 numbers, one by one.', recap: 'We made an empty memory box for numbers we have already seen.' },
    { line: 4, title: 'The loop picks the first number.', hint: 'Round 1 · choosing a number', vars: { index: '0', value: '2', target: '9', seen: '{}' }, map: [], array: 0, caption: 'Round 1: index is 0, so value is the first number, 2.', what: 'This line starts a loop. It picks one number and its place in the list.', changed: 'index: empty → 0. value: empty → 2. The loop chose the first item.', why: 'There are 4 numbers to check, so the loop checks them one at a time.', next: 'Next, the program asks: what number would join 2 to make 9?', recap: 'Round 1 of 4: the loop is checking 2 at position 0.' },
    { line: 5, title: 'It calculates the missing partner.', hint: 'Finding the complement', vars: { index: '0', value: '2', complement: '7', target: '9', seen: '{}' }, map: [], array: 0, caption: '9 - 2 is 7. So 7 is the partner we need.', what: 'This line subtracts the current number from the target.', changed: 'complement: empty → 7. The missing partner is 7.', why: 'If we find 7 in our memory, 7 + 2 will equal the target 9.', next: 'Now it checks whether 7 is already in seen.', recap: 'The partner needed for 2 is 7.' },
    { line: 6, title: '7 is not remembered yet.', hint: 'Checking the memory box', vars: { index: '0', value: '2', complement: '7', target: '9', seen: '{}' }, map: [], array: 0, caption: 'The map is empty, so 7 is not inside it. The answer is not ready yet.', what: 'This line checks whether the missing partner is in the map.', changed: 'Nothing changes. seen is still {}.', why: 'The condition is false because we have not remembered any number yet.', next: 'The program saves 2 in seen, then the loop moves to the next number.', recap: 'Round 1: 7 was not in memory, so the loop keeps going.' },
    { line: 9, title: 'It remembers where 2 lives.', hint: 'Saving this number', vars: { index: '0', value: '2', complement: '7', target: '9', seen: '{2: 0}' }, map: [{ key: '2', value: 'index 0' }], array: 0, caption: 'The map now says: number 2 was at index 0.', what: 'This line puts the current number and its place into the map.', changed: 'seen: {} → {2: 0}. We remembered 2.', why: 'If a later number needs 2 as its partner, we can find it immediately.', next: 'The loop repeats. It now checks the second number, 7.', recap: 'Round 1 ends: 2 is safely stored at position 0.' },
    { line: 4, title: 'The loop picks 7.', hint: 'Round 2 · choosing a number', vars: { index: '1', value: '7', complement: '7', target: '9', seen: '{2: 0}' }, map: [{ key: '2', value: 'index 0' }], array: 1, caption: 'Round 2: index is 1, so value is 7.', what: 'The loop comes back to its first line and picks the next number.', changed: 'index: 0 → 1. value: 2 → 7. The pointer moves one place right.', why: 'The first round finished without an answer, so the loop repeats for the next item.', next: 'Next, it calculates the partner needed for 7.', recap: 'Round 2 of 4: now the loop is checking 7.' },
    { line: 5, title: 'The missing partner is 2.', hint: 'Finding the complement', vars: { index: '1', value: '7', complement: '2', target: '9', seen: '{2: 0}' }, map: [{ key: '2', value: 'index 0' }], array: 1, caption: '9 - 7 is 2. The map already remembers 2.', what: 'This line finds the number needed to reach the target.', changed: 'complement: 7 → 2. The needed partner changed with value.', why: '7 needs 2 because 7 + 2 equals 9.', next: 'Now it checks whether 2 is inside seen.', recap: 'The partner needed for 7 is 2.' },
    { line: 6, title: 'The answer is in the box!', hint: 'The condition is true', vars: { index: '1', value: '7', complement: '2', target: '9', seen: '{2: 0}' }, map: [{ key: '2', value: 'index 0', active: true }], array: 1, caption: 'The condition is true: 2 is in seen. We found the pair.', what: 'This line asks if 2 is in the map.', changed: 'No new value is made. The condition is false for no longer: it is true.', why: '2 is already remembered at index 0, and 2 + 7 is 9.', next: 'The next line prints the two positions: 0 and 1.', recap: 'Round 2: the condition is true, so the search has found its answer.' },
    { line: 7, title: 'It prints the two places.', hint: 'Showing the answer', vars: { index: '1', value: '7', complement: '2', target: '9', seen: '{2: 0}', answer: '[0, 1]' }, map: [{ key: '2', value: 'index 0', active: true }], array: 1, found: true, caption: 'The program prints 0 and 1. Those are the places of 2 and 7.', what: 'This line shows the saved place of 2 and the current place of 7.', changed: 'answer: empty → [0, 1]. The two positions are now visible.', why: 'These two positions contain numbers that add up to 9.', next: 'The break line stops the loop. There is no need to search more.', recap: 'The answer is [0, 1] because numbers at those places add up to 9.' },
    { line: 8, title: 'The loop stops early.', hint: 'Finishing with a clear answer', vars: { index: '1', value: '7', complement: '2', target: '9', seen: '{2: 0}', answer: '[0, 1]' }, map: [{ key: '2', value: 'index 0', active: true }], array: 1, found: true, caption: 'break means stop this loop now. The answer has already been found.', what: 'This line leaves the loop immediately.', changed: 'The loop changes from running → stopped.', why: 'The correct pair is found, so checking 11 and 15 would be extra work.', next: 'The program reaches the end. It has completed its job.', recap: 'The loop ended after 2 rounds, instead of checking all 4 numbers.' },
  ];
  const defaultSteps = steps.slice();
  const $ = (id) => document.getElementById(id);
  const visual = { step: 0, playing: false, rate: 1, voiceMuted: false, fxMuted: false, voiceVolume: .9, fxVolume: .45, audio: null, userGesture: false, explainVariant: 0 };
  const qs = { editor: $('codeEditor'), array: $('arrayVisual'), pointer: $('pointerVisual'), vars: $('variableVisual'), map: $('mapVisual'), line: $('activeLineNumber'), lineCode: $('activeLineCode'), title: $('explainTitle'), level: $('explainLevelLabel'), what: $('whatText'), changed: $('changedText'), why: $('whyText'), next: $('nextText'), caption: $('captionText'), sceneCaption: $('sceneCaption'), stepLabel: $('stepLabel'), hint: $('stageHint'), round: $('roundLabel'), recap: $('roundRecap'), progress: $('progressSlider'), dockStep: $('dockStepTitle'), dockStatus: $('dockStatus'), dockProgress: $('dockProgressText'), dockTime: $('dockTime'), timeline: $('timeline'), fill: document.querySelector('.timeline-fill'), thumb: document.querySelector('.timeline-thumb'), percent: $('timelinePercent'), modal: $('predictionModal'), options: $('predictionOptions'), feedback: $('predictionFeedback'), break: $('breakSummary') };
  const narration = [
    'This line makes an array. An array is a row of items kept in order. numbers changed from empty to four numbers. We need them before we can search. Next, the program sets the target.',
    'This line stores the total we want. target changed from empty to 9. We need a finish line. Next, it makes an empty map.',
    'This line creates a map. A map is like a small labeled cabinet. seen changed from empty to blank. We will use it to remember old numbers. Next, the loop begins.',
  ];
  function readEditorSource() {
    const editor = qs.editor;
    const value = editor.innerText || editor.textContent || '';
    return value.replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }
  function applyUserTrace() {
    const source = readEditorSource();
    const language = $('languageSelect').value;
    if (!window.CodeFlowTraceEngine) {
      qs.title.textContent = 'Trace engine is still loading.';
      qs.what.textContent = 'Please wait a moment, then click Visualize again.';
      return;
    }
    const result = window.CodeFlowTraceEngine.createTrace(source, language);
    if (result.error) {
      qs.title.textContent = 'I could not trace this code yet.';
      qs.hint.textContent = 'Try the supported teaching subset';
      qs.what.textContent = result.error.message;
      qs.changed.textContent = 'Nothing changed because the trace did not start.';
      qs.why.textContent = 'CodeFlow never runs pasted code. It safely reads a small teaching subset instead.';
      qs.next.textContent = 'Fix the highlighted idea and click Visualize again.';
      qs.caption.textContent = result.error.message;
      qs.dockStatus.textContent = 'Trace needs a small syntax fix';
      return;
    }
    codeLines.splice(0, codeLines.length, ...result.codeLines);
    steps.splice(0, steps.length, ...result.steps);
    visual.narrationCache = null;
    renderStep(0, false);
    qs.sceneCaption.textContent = result.summary;
    $('programSummary').textContent = result.summary;
    $('breakSummary').textContent = result.bugExample ? `${result.bugExample.code}. ${result.bugExample.explanation}` : 'Try changing one input and predict which branch will run.';
    fx('pop');
    requestNarrationBatch();
  }
  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function highlightCode(line) { qs.editor.innerHTML = codeLines.map((lineText, i) => `<span class="code-line ${i + 1 === line ? 'active' : ''}" data-line="${String(i + 1).padStart(2, '0')}">${formatCode(lineText)}</span>`).join(''); }
  function formatCode(line) { if (!line) return '&nbsp;'; let out = escapeHtml(line); out = out.replace(/\b(for|in|if|break)\b/g, '<span class="kw">$1</span>').replace(/\b(enumerate|print)\b/g, '<span class="fn">$1</span>').replace(/(".*?")/g, '<span class="str">$1</span>'); return out; }
  function renderArray(step) { const state = step.state || {}; const arrayEntry = Object.entries(state).find(([, value]) => Array.isArray(value)); const values = arrayEntry ? arrayEntry[1] : [2, 7, 11, 15]; const pointer = Number.isInteger(state.index) ? state.index : Number.isInteger(state.i) ? state.i : (Number.isInteger(step.array) ? step.array : -1); qs.array.innerHTML = values.map((value, i) => `<div class="array-cell ${i === pointer ? 'active' : ''} ${step.found && (i === 0 || i === 1) ? 'found' : ''}" style="--i:${i}">${escapeHtml(value)}<span class="cell-index">${i}</span></div>`).join(''); qs.pointer.innerHTML = pointer >= 0 ? `<span class="pointer-label" style="left:${pointer * 57}px">value</span>` : ''; }
  function renderMemory(step) { qs.vars.innerHTML = Object.entries(step.vars || {}).map(([name, value]) => `<div class="variable-box ${name === 'value' || name === 'complement' ? 'changed' : ''}"><span class="var-name">${escapeHtml(name)}</span><span class="var-value">${escapeHtml(value)}</span></div>`).join(''); qs.map.innerHTML = (step.map || []).map((entry) => `<div class="map-entry ${entry.active ? 'changed' : ''}"><span class="map-key">${escapeHtml(entry.key)}</span><span>→</span><span class="map-value">${escapeHtml(entry.value)}</span></div>`).join('') || '<span class="muted-memory">empty for now</span>'; }
  function setExplanation(step) { qs.title.textContent = step.title; qs.line.textContent = String(step.line).padStart(2, '0'); qs.lineCode.textContent = codeLines[step.line - 1] || 'program finished'; qs.what.textContent = step.what; qs.changed.textContent = step.changed; qs.why.textContent = step.why; qs.next.textContent = step.next; qs.caption.textContent = narration[visual.step] || `${step.what} ${step.changed} ${step.why} Next, ${step.next}`; qs.sceneCaption.textContent = step.caption; qs.level.textContent = `${$('levelSelect').value[0].toUpperCase() + $('levelSelect').value.slice(1)} explanation · ${$('narrationLanguage').value}`; }
  function renderStep(index, announce) { visual.step = Math.max(0, Math.min(steps.length - 1, index)); const step = steps[visual.step]; highlightCode(step.line); renderArray(step); renderMemory(step); setExplanation(step); const percent = steps.length > 1 ? visual.step / (steps.length - 1) * 100 : 100; qs.stepLabel.innerHTML = `Step ${String(visual.step + 1).padStart(2, '0')} <b>/ ${steps.length}</b>`; qs.hint.textContent = step.hint || 'Following the next supported line'; qs.round.textContent = step.round ? `Round ${step.round}` : step.line === 4 ? (visual.step < 7 ? 'Round ' + (visual.step < 4 ? '1' : '2') : 'Answer found') : 'Step recap'; qs.recap.textContent = ' ' + (step.recap || step.next || 'The simulator moves to the next step.'); qs.progress.max = Math.max(1, steps.length - 1); qs.progress.value = visual.step; qs.dockProgress.textContent = `${String(visual.step + 1).padStart(2, '0')} / ${steps.length}`; qs.dockStep.textContent = `Step ${String(visual.step + 1).padStart(2, '0')} · ${step.title}`; qs.dockStatus.textContent = announce ? 'Reading this step…' : 'Click play to hear the lesson'; qs.dockTime.textContent = `0:${String(Math.round(visual.step * 3)).padStart(2, '0')}`; qs.fill.style.width = `${percent}%`; qs.thumb.style.left = `${percent}%`; qs.percent.textContent = `${Math.round(percent)}% complete`; qs.timeline.setAttribute('aria-valuemax', Math.max(1, steps.length - 1)); qs.timeline.setAttribute('aria-valuenow', visual.step); if (announce) speakStep(); }
  function stopVoice() { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); }
  function speakStep(text) { stopVoice(); const textToRead = text || `${qs.title.textContent}. What: ${qs.what.textContent} What changed: ${qs.changed.textContent} Why: ${qs.why.textContent} What happens next: ${qs.next.textContent}`; if (!visual.userGesture || visual.voiceMuted || !('speechSynthesis' in window) || typeof window.SpeechSynthesisUtterance !== 'function') { qs.dockStatus.textContent = 'Captions on · speech unavailable or muted'; return Promise.resolve(); } return new Promise((resolve) => { const utter = new window.SpeechSynthesisUtterance(textToRead); utter.rate = visual.rate; utter.volume = visual.voiceVolume; utter.onend = () => { qs.dockStatus.textContent = 'Ready for the next step'; resolve(); }; utter.onerror = () => resolve(); window.speechSynthesis.speak(utter); }); }
  function audioContext() { if (!visual.audio) { try { visual.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { visual.audio = false; } } return visual.audio; }
  function fx(kind) { if (!visual.userGesture || visual.fxMuted) return; const context = audioContext(); if (!context) return; const osc = context.createOscillator(); const gain = context.createGain(); const now = context.currentTime; const tones = { tick: [480, .045], up: [680, .1], down: [270, .1], pop: [760, .12], whoosh: [190, .16], click: [390, .06], chime: [880, .24], swap: [580, .13], error: [120, .2] }; const tone = tones[kind] || tones.tick; osc.type = kind === 'whoosh' ? 'sine' : 'triangle'; osc.frequency.setValueAtTime(tone[0], now); if (kind === 'up') osc.frequency.exponentialRampToValueAtTime(950, now + tone[1]); if (kind === 'down') osc.frequency.exponentialRampToValueAtTime(150, now + tone[1]); gain.gain.setValueAtTime(Math.max(.001, visual.fxVolume * .16), now); gain.gain.exponentialRampToValueAtTime(.001, now + tone[1]); osc.connect(gain).connect(context.destination); osc.start(now); osc.stop(now + tone[1]); }
  async function playStep(index) { visual.userGesture = true; renderStep(index, false); fx('tick'); await speakStep(); }
  async function nextStep() { stopVoice(); if (visual.step >= steps.length - 1) { visual.playing = false; $('playButton').textContent = '▶'; fx('chime'); qs.dockStatus.textContent = 'Lesson complete · nice work'; return; } await playStep(visual.step + 1); if (visual.playing) setTimeout(() => { if (visual.playing) nextStep(); }, Math.max(150, 520 / visual.rate)); }
  function togglePlay() { visual.userGesture = true; visual.playing = !visual.playing; $('playButton').textContent = visual.playing ? 'Ⅱ' : '▶'; if (visual.playing) { speakStep().then(() => { if (visual.playing) nextStep(); }); } else { stopVoice(); qs.dockStatus.textContent = 'Paused · captions stay visible'; } }
  function updateVoiceChoice() { if (visual.voice) { const voices = window.speechSynthesis.getVoices(); const selected = voices.find((v) => v.lang.toLowerCase().startsWith($('narrationLanguage').value === 'English' ? 'en' : 'hi')); if (selected) visual.voice.voice = selected; } }
  function prediction() { visual.userGesture = true; const step = steps[visual.step]; qs.modal.hidden = false; qs.feedback.textContent = ''; const current = step.vars.total || (visual.step < 8 ? '0' : '9'); const answers = [...new Set([current, String(Number(current) + 2), String(Number(current) - 2)])].slice(0, 3); qs.options.innerHTML = answers.map((answer) => `<button class="prediction-option" type="button" data-answer="${answer}">${answer}</button>`).join(''); }
  function handlePrediction(event) { const button = event.target.closest('[data-answer]'); if (!button) return; const step = steps[visual.step]; const right = step.vars.total || (visual.step < 8 ? '0' : '9'); const correct = button.dataset.answer === String(right); qs.feedback.textContent = correct ? `✓ Nice prediction. The value is ${right}.` : `Not quite. The value is ${right}, because ${step.changed}`; fx(correct ? 'chime' : 'error'); document.querySelectorAll('.prediction-option').forEach((item) => { item.disabled = true; }); }
  async function requestNarrationBatch() { if (visual.narrationCache) return visual.narrationCache; try { const response = await fetch('/api/narration', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: codeLines.join('\n'), trace: steps, level: $('levelSelect').value, language: $('narrationLanguage').value }) }); if (response.ok) { const data = await response.json(); if (data.steps) visual.narrationCache = data; } } catch (_) { /* The complete rule-based narration remains the offline fallback. */ } return visual.narrationCache; }
  async function explainDifferently() { visual.userGesture = true; visual.explainVariant += 1; const original = qs.what.textContent; qs.what.textContent = visual.explainVariant % 2 ? `Imagine a teacher pointing at one card in a row. ${original}` : `Think of this as a basket being checked one fruit at a time. ${original}`; qs.caption.textContent = qs.what.textContent; qs.dockStatus.textContent = 'New analogy ready · cached for this step'; try { const response = await fetch('/api/narration', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: codeLines.join('\n'), step: visual.step, level: $('levelSelect').value, language: $('narrationLanguage').value, trace: steps, mode: 'different_analogy' }) }); if (response.ok) { const data = await response.json(); if (data.what) qs.what.textContent = data.what; } } catch (_) { /* rule-based fallback stays visible */ } speakStep(qs.what.textContent); }
  function bind() { codeLines.forEach(() => {}); $('visualizeButton').addEventListener('click', () => { visual.userGesture = true; renderStep(0, false); fx('pop'); requestNarrationBatch(); }); $('resetCode').addEventListener('click', () => renderStep(0, false)); $('playButton').addEventListener('click', togglePlay); $('nextButton').addEventListener('click', () => { visual.userGesture = true; nextStep(); }); $('backButton').addEventListener('click', () => { visual.userGesture = true; visual.playing = false; $('playButton').textContent = '▶'; stopVoice(); renderStep(visual.step - 1, true); fx('down'); }); qs.progress.addEventListener('input', () => { visual.userGesture = true; visual.playing = false; $('playButton').textContent = '▶'; stopVoice(); renderStep(Number(qs.progress.value), true); }); qs.timeline.addEventListener('click', (event) => { const rect = qs.timeline.getBoundingClientRect(); const value = Math.round(((event.clientX - rect.left) / rect.width) * (steps.length - 1)); visual.userGesture = true; stopVoice(); renderStep(value, true); }); $('repeatButton').addEventListener('click', () => { visual.userGesture = true; speakStep(); fx('tick'); }); $('differentButton').addEventListener('click', explainDifferently); $('predictionButton').addEventListener('click', prediction); qs.options.addEventListener('click', handlePrediction); $('closePrediction').addEventListener('click', () => { qs.modal.hidden = true; }); $('helpButton').addEventListener('click', () => { $('helpModal').hidden = false; }); $('closeHelp').addEventListener('click', () => { $('helpModal').hidden = true; }); $('voiceMute').addEventListener('click', () => { visual.voiceMuted = !visual.voiceMuted; $('voiceMute').textContent = visual.voiceMuted ? '◌' : '◖'; stopVoice(); }); $('effectsMute').addEventListener('click', () => { visual.fxMuted = !visual.fxMuted; $('effectsMute').textContent = visual.fxMuted ? '○' : '⌁'; }); $('voiceVolume').addEventListener('input', (e) => { visual.voiceVolume = Number(e.target.value); }); $('effectsVolume').addEventListener('input', (e) => { visual.fxVolume = Number(e.target.value); }); $('levelSelect').addEventListener('change', () => setExplanation(steps[visual.step])); $('narrationLanguage').addEventListener('change', () => setExplanation(steps[visual.step])); $('themeButton').addEventListener('click', () => document.body.classList.toggle('warm-mode')); $('tryBugButton').addEventListener('click', () => { qs.break.textContent = 'Try numbers = [3] and target = 20. No pair exists, so the loop reaches the end without printing an answer.'; document.querySelector('.break-card').scrollIntoView({ behavior: 'smooth', block: 'center' }); }); $('micButton').addEventListener('click', () => { const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition; if (!Recognition) { qs.dockStatus.textContent = 'Voice commands are not supported here · use the buttons'; return; } const recognition = new Recognition(); recognition.onresult = (event) => { const heard = event.results[0][0].transcript.toLowerCase(); if (heard.includes('next')) nextStep(); else if (heard.includes('back')) $('backButton').click(); else if (heard.includes('pause')) { if (visual.playing) togglePlay(); } else if (heard.includes('play')) { if (!visual.playing) togglePlay(); } else if (heard.includes('repeat')) speakStep(); else if (heard.includes('slower')) { visual.rate = Math.max(.5, visual.rate - .15); } else if (heard.includes('faster')) { visual.rate = Math.min(1.8, visual.rate + .15); } else if (heard.includes('explain again')) explainDifferently(); }; recognition.start(); qs.dockStatus.textContent = 'Listening for: next, back, pause, play…'; }); document.addEventListener('keydown', (event) => { if (event.target.matches('input,select,textarea')) return; if (event.key === ' ') { event.preventDefault(); togglePlay(); } if (event.key === 'ArrowRight') nextStep(); if (event.key === 'ArrowLeft') $('backButton').click(); if (event.key.toLowerCase() === 'r') speakStep(); if (event.key.toLowerCase() === 'm') $('voiceMute').click(); }); }
  if (qs.editor && qs.array) { renderStep(0, false); bind(); window.CodeFlowApplyUserTrace = applyUserTrace; window.CodeFlowResetSource = function () { codeLines.splice(0, codeLines.length, ...defaultSource.split('\n')); steps.splice(0, steps.length, ...defaultSteps); renderStep(0, false); }; }
}());

/* The editor is contenteditable so a learner can write or paste a program.
   Keep this small bridge outside the lesson closure: it also makes the source
   action easy to smoke-test without exposing the internal execution state. */
(function () {
  'use strict';
  const editor = document.getElementById('codeEditor');
  const visualize = document.getElementById('visualizeButton');
  if (!editor || !visualize) return;
  visualize.addEventListener('click', function (event) {
    event.stopImmediatePropagation();
    if (typeof window.CodeFlowApplyUserTrace === 'function') window.CodeFlowApplyUserTrace();
  }, true);
  const reset = document.getElementById('resetCode');
  if (reset) reset.addEventListener('click', function (event) {
    event.stopImmediatePropagation();
    if (typeof window.CodeFlowResetSource === 'function') window.CodeFlowResetSource();
  }, true);
}());
