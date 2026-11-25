/* Часть 4 — Map-First Dashboard.
   Данных внутри страницы нет: всё берётся из REST API Части 4.
   Маршруты: /lakes, /predict/{id}?date&mode, /history/{id}?mode, /metrics, POST /lab/upload. */
'use strict';

const API_BASE = window.DASHBOARD_API || '';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[m]));
const API = (new URLSearchParams(location.search).get('api') || API_BASE
  || (/^https?:$/.test(location.protocol) ? location.origin : 'http://127.0.0.1:8000')).replace(/\/$/, '');

const MODES = {satellite: 'Спутник', lab: 'Лаборатория'};
const RISK = {
  GREEN: {label: 'Норма', cls: 'ok', color: '#2E7D4F'},
  YELLOW: {label: 'Внимание', cls: 'warn', color: '#D99A12'},
  RED: {label: 'Опасность', cls: 'bad', color: '#B8322A'},
};
const NEUTRAL = {label: 'Нет наблюдения', cls: 'err', color: '#7A8E96'};
const OBS_TEXT = {
  valid: 'реальное наблюдение',
  interpolated_1step: 'восстановлено интерполяцией (1 декада)',
  cloudy_missing: 'облачность, чистых наблюдений нет',
  ice_cover: 'ледяной покров',
  insufficient_pixels: 'недостаточно чистых пикселей воды',
};
const DECADES = [1, 11, 21];

/* ---------------- API ---------------- */
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
async function api(path, opts = {}) {
  let r;
  try { r = await fetch(API + path, {headers: {Accept: 'application/json', ...(opts.headers || {})}, ...opts}); }
  catch (e) { throw new ApiError(0, `Нет связи с сервером API (${API}).`); }
  if (!r.ok) {
    let detail = '';
    try {
      const j = await r.json();
      detail = Array.isArray(j.detail) ? j.detail.map(d => d.msg || d).join('; ') : (j.detail || '');
    } catch (e) { /* тело не JSON */ }
    throw new ApiError(r.status, detail || `Ошибка сервера (${r.status}).`);
  }
  return r.json();
}
const qs = o => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) =>
  encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');

/* ---------------- состояние ---------------- */
const S = {
  lakes: [], byId: {}, selected: null, mode: 'satellite', date: null, limit: 36,
  res: {}, token: 0, histToken: 0, metrics: null, ready: false,
};
const cache = new Map();          // ключ -> Promise
let map = null, layers = {}, chart = null;

function cacheGet(key, make) {
  if (!cache.has(key)) {
    const p = make();
    p.catch(() => cache.delete(key));            // ошибки не кешируем
    cache.set(key, p);
  }
  return cache.get(key);
}
const getPredict = (id, date, mode) =>
  cacheGet(`p|${id}|${date || ''}|${mode}`, () => api('/predict/' + encodeURIComponent(id) + '?' + qs({date, mode})));
const getHistory = (id, mode, date, limit) =>
  cacheGet(`h|${id}|${mode}|${date || ''}|${limit}`, () => api('/history/' + encodeURIComponent(id) + '?' + qs({mode, date, limit})));

/* ---------------- формат ---------------- */
const fmtNum = (v, d = 1) => (v == null || Number.isNaN(v)) ? '—' : (Math.round(v * 10 ** d) / 10 ** d).toLocaleString('ru-RU');
const fmtDate = iso => iso ? new Date(iso + 'T00:00:00').toLocaleDateString('ru-RU', {day: 'numeric', month: 'long', year: 'numeric'}) : '—';
const fmtShort = iso => iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) : '';
const pct = v => v == null ? '—' : Math.round(v * 100) + '%';
const riskOf = d => (d && d.alert_level && RISK[d.alert_level]) || null;
const modeLabel = m => MODES[m] || m;

/* ---------------- карта ---------------- */
function initMap() {
  if (map) return;
  if (typeof L === 'undefined') {
    $('#mapnote').innerHTML = '<div><h2>Карта недоступна</h2><p>Не удалось загрузить библиотеку Leaflet (нужен интернет). Данные API при этом доступны.</p></div>';
    return;
  }
  map = L.map('map', {zoomControl: true});
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© участники OpenStreetMap'});
  const esri = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 18, attribution: 'Esri, Maxar, Earthstar Geographics'});
  osm.addTo(map);
  if (L.control && L.control.layers) L.control.layers({'Карта': osm, 'Спутник': esri}).addTo(map);
  map.setView([53.75, 27.9], 7);
}

function lakeLayer(wb, style) {
  if (wb.geometry && wb.geometry.type) return L.geoJSON(wb.geometry, {style: () => style});
  if (wb.bbox) return L.rectangle([[wb.bbox.min_lat, wb.bbox.min_lon], [wb.bbox.max_lat, wb.bbox.max_lon]], style);
  return null;
}

function drawLakes() {
  if (!map) return;
  Object.values(layers).forEach(l => { if (map.removeLayer) map.removeLayer(l); });
  layers = {};
  S.lakes.forEach(wb => {
    const layer = lakeLayer(wb, {weight: 2.5, color: NEUTRAL.color, fillColor: NEUTRAL.color, fillOpacity: .32});
    if (!layer) return;
    layer.addTo(map);
    if (layer.on) layer.on('click', () => selectLake(wb.id));
    if (layer.bindTooltip) layer.bindTooltip(esc(wb.name), {sticky: true});
    layers[wb.id] = layer;
  });
  paintLakes();
  fitAll();
}

function paintLakes() {
  S.lakes.forEach(wb => {
    const layer = layers[wb.id];
    if (!layer || !layer.setStyle) return;
    const r = S.res[wb.id];
    const risk = r && r.ok ? riskOf(r.d) : null;
    const color = risk ? risk.color : NEUTRAL.color;
    layer.setStyle({color, fillColor: color, fillOpacity: wb.id === S.selected ? .46 : .32,
                    weight: wb.id === S.selected ? 5 : 2.5, dashArray: wb.id === S.selected ? '7 4' : null});
    if (layer.bindTooltip) {
      const label = r && r.ok ? (risk ? risk.label : NEUTRAL.label) : 'нет данных';
      const val = r && r.ok && r.d.chl_a_forecast != null ? `, прогноз ${r.d.chl_a_forecast} мкг/л` : '';
      layer.bindTooltip(`${esc(wb.name)}: ${label}${val}`, {sticky: true});
    }
  });
}

function fitAll() {
  if (!map) return;
  if (S.lakes.length === 1) return focusLake(S.lakes[0].id);
  const bounds = [];
  S.lakes.forEach(wb => { if (layers[wb.id] && layers[wb.id].getBounds) bounds.push(layers[wb.id].getBounds()); });
  if (!bounds.length) return;
  if (map.fitBounds && L.latLngBounds) {
    let b = bounds[0];
    for (let i = 1; i < bounds.length; i++) b = b.extend(bounds[i]);
    map.fitBounds(b, {padding: [40, 40], maxZoom: 10});
  }
}
function focusLake(id) {
  const l = layers[id];
  if (map && l && l.getBounds && map.fitBounds) map.fitBounds(l.getBounds(), {padding: [60, 60], maxZoom: 12});
}

/* ---------------- загрузка ---------------- */
function setBusy(sel, b) { const e = $(sel); if (e) { e.setAttribute('aria-busy', b); e.classList.toggle('loading', b); } }
function showFatal(msg) {
  const e = $('#apierr'); if (!e) return;
  $('#apierr-msg').textContent = msg + ' Запустите сервер: uvicorn src.api.main:app';
  e.hidden = false;
}
function hideFatal() { const e = $('#apierr'); if (e) e.hidden = true; }

async function loadStatus() {
  try {
    const s = await api('/');
    const stubs = Object.entries(s.components || {}).filter(([, v]) => !String(v).startsWith('реальная'));
    const el = $('#stub');
    el.hidden = !stubs.length;
    if (stubs.length) el.querySelector('span').textContent =
      'Тестовые данные: не подключены ' + stubs.map(([k]) => ({part1: 'Часть 1', part2: 'Часть 2', part3: 'Часть 3'}[k] || k)).join(', ') +
      '. Значения не являются реальными измерениями.';
  } catch (e) { /* баннер не критичен */ }
}

async function loadAll(date) {
  const t = ++S.token;
  setBusy('#mapnote', true);
  const ids = S.lakes.map(w => w.id);
  const settled = await Promise.allSettled(ids.map(id => getPredict(id, date, S.mode)));
  if (t !== S.token) return;                    // устарело: пользователь уже сменил дату/режим
  S.res = {};
  settled.forEach((s, i) => {
    S.res[ids[i]] = s.status === 'fulfilled' ? {ok: true, d: s.value} : {ok: false, err: s.reason};
    if (s.status === 'fulfilled') {                 // панель запросит дату декады — ответ уже есть
      cache.set(`p|${ids[i]}|${s.value.date_used}|${S.mode}`, Promise.resolve(s.value));
    }
  });
  setBusy('#mapnote', false);

  const allDown = ids.length > 0 && ids.every(id => !S.res[id].ok && S.res[id].err && S.res[id].err.status === 0);
  if (allDown) {
    showFatal(S.res[ids[0]].err.message);
    $('#mapnote').hidden = false;
    $('#mapnote').innerHTML = '<div><h2>API недоступен</h2><p>Проверьте, что сервер запущен, и нажмите «Повторить».</p></div>';
    return;
  }
  hideFatal();

  const firstOk = ids.map(id => S.res[id]).find(r => r.ok);
  S.date = firstOk ? firstOk.d.date_used : (date || S.date);
  if ($('#dinp')) $('#dinp').value = S.date || '';
  const sub = $('#sub');
  if (sub) sub.textContent = `${modeLabel(S.mode)} · прогноз на 10 дней`;
  const upd = $('#upd');
  if (upd) {
    let txt = 'Данные с сервера: ' + new Date().toLocaleTimeString('ru-RU') + '.';
    if (date && firstOk && date !== firstOk.d.date_used) txt += ` Запрошено ${fmtDate(date)}, взята ближайшая декада ${fmtDate(firstOk.d.date_used)}.`;
    upd.textContent = txt;
  }
  paintLakes();
  if (S.selected) loadPanel(S.selected);
}

/* ---------------- панель ---------------- */
function skeletonHTML(wb) {
  return `<div class="p-head"><div><h2>${esc(wb.name)}</h2><p class="meta">Загрузка…</p></div>
    <button type="button" class="iconbtn close" data-action="close" aria-label="Закрыть">×</button></div>
    <div class="p-body"><div class="skeleton" style="width:60%"></div><div class="skeleton"></div>
    <div class="skeleton" style="width:80%"></div><div class="skeleton" style="height:120px"></div></div>`;
}

function kv(label, value, cls = '') {
  if (value == null || value === '') return '';
  return `<div class="${cls}"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
}
function section(title, body) { return `<section class="section"><h3>${esc(title)}</h3>${body}</section>`; }

function passportHTML(wb) {
  const type = wb.type === 'reservoir' ? 'водохранилище' : 'озеро';
  const coords = (wb.lat != null && wb.lon != null) ? `${fmtNum(wb.lat, 4)}, ${fmtNum(wb.lon, 4)}` : null;
  const items = [
    kv('Тип', type),
    kv('Площадь', wb.area_km2 != null ? fmtNum(wb.area_km2, 1) + ' км²' : null),
    kv('Средняя глубина', wb.mean_depth_m != null ? fmtNum(wb.mean_depth_m, 1) + ' м' : null),
    kv('Максимальная глубина', wb.max_depth_m != null ? fmtNum(wb.max_depth_m, 1) + ' м' : null),
    kv('Объём', wb.volume_mln_m3 != null ? fmtNum(wb.volume_mln_m3, 1) + ' млн м³' : null),
    kv('Водосбор', wb.watershed_ratio != null ? '×' + fmtNum(wb.watershed_ratio, 1) + ' к озеру' : (wb.watershed_km2 != null ? fmtNum(wb.watershed_km2, 0) + ' км²' : null)),
    kv('Координаты', coords),
  ].join('');
  const prot = wb.protected_area ? `<div class="protected">🛡 ${esc(wb.protected_area)}</div>` : '';
  return `<dl class="passport">${items}${prot}</dl>`;
}

function observationHTML(pred) {
  const o = pred.observation;
  if (!o) return '';
  const bits = [`Наблюдение: ${fmtDate(o.date)}`, OBS_TEXT[o.obs_status] || o.obs_status || '—'];
  if (o.scene_id) bits.push(`сцена ${o.scene_id}`);
  if (o.source) bits.push(o.source);
  return `<p class="hint">${esc(bits.join(' · '))}</p>`;
}

function forecastHTML(pred) {
  if (pred.chl_a_forecast == null) {
    return `<div class="empty"><strong>Прогноз не рассчитан</strong>
      <p>${esc((pred.reasons && pred.reasons[0]) || 'Для этой декады нет надёжного наблюдения.')}</p></div>`;
  }
  const range = pred.pred_low_ug_l != null && pred.pred_high_ug_l != null
    ? `Интервал ±${fmtNum(pred.uncertainty_ug_l, 1)} мкг/л: ${fmtNum(pred.pred_low_ug_l, 1)}–${fmtNum(pred.pred_high_ug_l, 1)}`
    : 'Доверительный интервал не рассчитан (нет MAE модели)';
  const probs = [
    pred.bloom_probability != null ? `<span>Риск цветения ≥25 мкг/л: <b>${pct(pred.bloom_probability)}</b></span>` : '',
    pred.attention_probability != null ? `<span>Риск внимания ≥15 мкг/л: <b>${pct(pred.attention_probability)}</b></span>` : '',
  ].filter(Boolean).join('');
  return `<div class="forecast">
    <div class="top"><span class="lbl">Через ${pred.horizon_days} суток</span>
      <span class="num">${fmtNum(pred.chl_a_forecast, 1)}<small> мкг/л</small></span></div>
    <div class="range">${esc(range)}</div>
    ${probs ? `<div class="probs">${probs}</div>` : ''}
  </div>`;
}

function qualityHTML(pred) {
  const o = pred.observation || {};
  const items = [
    kv('Статус декады', OBS_TEXT[pred.obs_status] || pred.obs_status || '—'),
    kv('Снимков в декаде', o.scenes_in_decade ?? '—'),
    kv('Чистых пикселей воды', o.valid_water_pixels == null ? '—' : Number(o.valid_water_pixels).toLocaleString('ru-RU')),
    kv('Интерполяция', pred.is_interpolated ? 'да (1 декада)' : 'нет'),
  ].join('');
  const sources = (pred.sources || []).length
    ? `<ul class="sources">${pred.sources.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : '';
  const notes = (pred.notes || []).length
    ? `<p class="notes">${pred.notes.map(esc).join(' ')}</p>` : '';
  return `<dl class="quality">${items}</dl>${sources}${notes}`;
}

function modesHTML(wb) {
  const modes = wb.modes && wb.modes.length ? wb.modes : ['satellite'];
  return `<p class="hint">Доступные режимы: ${modes.map(m => `<b>${esc(modeLabel(m))}</b>`).join(', ')}.</p>`;
}

function uploadHTML(wb) {
  if (S.mode !== 'lab') return '';
  const today = new Date().toISOString().slice(0, 10);
  return section('Добавить лабораторную пробу', `<div class="upload">
    <h4>Новое измерение для «${esc(wb.name)}»</h4>
    <form id="labForm" novalidate>
      <div class="form-row">
        <label class="field">Дата пробы<input type="date" name="sample_date" value="${S.date || today}" max="${today}" required></label>
        <label class="field">Хлорофилл-а, мкг/л<input type="number" name="chl" min="0.001" max="1000" step="0.01" required></label>
        <label class="field">Прозрачность, м<input type="number" name="secchi" min="0.001" max="50" step="0.1"></label>
        <label class="field">Общий фосфор, мкг/л<input type="number" name="tp" min="0.001" max="1000" step="0.1"></label>
        <label class="field wide">Примечание<input type="text" name="note" maxlength="300" placeholder="номер бюллетеня / кто отобрал"></label>
      </div>
      <button type="submit" class="btn">Сохранить пробу</button>
      <p class="msg" id="labMsg" aria-live="polite"></p>
    </form></div>`);
}

function renderPanel(wb, predRes, histRes) {
  const panel = $('#panel'), body = $('#panelBody');
  if (!panel || !body) return;
  panel.hidden = false;
  const note = $('#mapnote'); if (note) note.hidden = true;

  if (!predRes || !predRes.ok) {
    const err = predRes ? predRes.err : null;
    const msg = err ? err.message : 'Данные не получены.';
    const extra = err && err.status === 404 ? ' Для этого водоёма может быть недоступен выбранный режим.' : '';
    body.innerHTML = `<div class="p-head"><div><h2>${esc(wb.name)}</h2><p class="meta">${esc(modeLabel(S.mode))}</p></div>
      <button type="button" class="iconbtn close" data-action="close" aria-label="Закрыть">×</button></div>
      <div class="p-body"><div class="empty"><strong>Нет данных</strong><p>${esc(msg)}${esc(extra)}</p></div>
      ${modesHTML(wb)}</div>`;
    return;
  }

  const p = predRes.d;
  const risk = riskOf(p);
  const badge = risk ? `<span class="badge ${risk.cls}">${risk.label}</span>` : `<span class="badge err">Нет наблюдения</span>`;
  const head = `<div class="p-head"><div><h2>${esc(wb.name)}</h2>
      <p class="meta">${esc(modeLabel(p.mode))} · декада ${fmtDate(p.date_used)}</p></div>
      ${badge}<button type="button" class="iconbtn close" data-action="close" aria-label="Закрыть">×</button></div>`;

  const current = `<div class="metrics">
      <div class="metric"><span class="val">${fmtNum(p.chl_a_current, 1)}<small> мкг/л</small></span><span class="lbl">Хлорофилл-а сейчас</span></div>
      <div class="metric"><span class="val">${fmtNum(p.trophic_index, 1)}</span><span class="lbl">Индекс Карлсона</span></div>
      <div class="metric"><span class="val" style="font-size:17px">${esc(p.trophic_class || '—')}</span><span class="lbl">Трофический класс</span></div>
    </div>${observationHTML(p)}`;

  const reasons = (p.reasons || []).length
    ? `<ul class="list">${p.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="hint">Причины не переданы.</p>';
  const recs = (p.recommendations || []).length
    ? `<ul class="list clean">${p.recommendations.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`
    : '<p class="hint">Рекомендации не требуются или не переданы.</p>';

  const weather = (p.temp_mean_14d != null || p.calm_fraction_7d != null)
    ? `<p class="hint">Погодный контекст: средняя температура за 14 сут ${fmtNum(p.temp_mean_14d, 1)} °C, доля штилевых дней за 7 сут ${pct(p.calm_fraction_7d)}.</p>` : '';

  const hist = histRes && histRes.ok ? historyHTML(histRes.d) : '<p class="hint">История недоступна.</p>';

  body.innerHTML = head + `<div class="p-body">
    ${section('Паспорт водоёма', passportHTML(wb))}
    ${section('Текущее состояние', current)}
    ${section(`Прогноз на ${p.horizon_days} дней`, forecastHTML(p) + weather)}
    ${section('Причины и рекомендации', `<h4 style="margin:0 0 4px;font-size:13px">Почему такой уровень</h4>${reasons}
      <h4 style="margin:12px 0 4px;font-size:13px">Что предлагает база знаний</h4>${recs}`)}
    ${section('Качество и доступность данных', qualityHTML(p) + modesHTML(wb))}
    ${section('История наблюдений', hist)}
    ${uploadHTML(wb)}
  </div>`;

  const chartData = histRes && histRes.ok ? histRes.d.points : [];
  makeChart(chartData);
  if ($('#labForm')) $('#labForm').dataset.wb = wb.id;
}

function historyHTML(h) {
  const opts = [[12, '4 месяца'], [24, '8 месяцев'], [36, '1 год'], [60, '2 года']]
    .map(([v, t]) => `<option value="${v}"${v === S.limit ? ' selected' : ''}>${t}</option>`).join('');
  return `<div class="history">
    <div class="tools"><span class="hint" style="margin:0">Декадные наблюдения и прогноз модели</span>
      <select id="histWin" aria-label="Период истории">${opts}</select></div>
    <div class="chartwrap"><canvas id="chart"></canvas></div>
    <div class="chartlegend"><span><i></i>Наблюдения</span><span><i class="dash"></i>Прогноз +10 сут</span>
      <span><i class="band"></i>Коридор ±MAE</span><span>— — пороги 15 и 25 мкг/л</span></div>
    ${(h.notes || []).length ? `<p class="notes">${h.notes.map(esc).join(' ')}</p>` : ''}
  </div>`;
}

function makeChart(points) {
  chart = null;
  if (typeof Chart === 'undefined') {
    const w = $('.chartwrap');
    if (w) w.innerHTML = '<p class="hint">Не удалось загрузить библиотеку графиков (нужен интернет).</p>';
    return;
  }
  const el = $('#chart');
  if (!el) return;
  const labels = points.map(p => p.date);
  const obs = points.map(p => p.observed);
  const fc = points.map(p => p.forecast);
  const lo = points.map(p => p.forecast_low);
  const hi = points.map(p => p.forecast_high);
  const hasBand = lo.some(v => v != null) && hi.some(v => v != null);
  const ds = [];
  if (hasBand) {
    ds.push({label: 'Нижняя граница', data: lo, borderWidth: 0, pointRadius: 0, fill: false, spanGaps: false});
    ds.push({label: 'Коридор ±MAE', data: hi, borderWidth: 0, pointRadius: 0,
             backgroundColor: 'rgba(20,102,111,.16)', fill: '-1', spanGaps: false});
  }
  ds.push({label: 'Наблюдения', data: obs, borderColor: '#14666F', backgroundColor: '#14666F',
           borderWidth: 2.2, pointRadius: 2, pointHoverRadius: 5, tension: .25, spanGaps: false});
  ds.push({label: 'Прогноз +10 сут', data: fc, borderColor: '#10303A', borderDash: [6, 4],
           borderWidth: 1.8, pointRadius: 0, tension: .25, spanGaps: false});
  ds.push({label: 'Порог цветения 25', data: labels.map(() => 25), borderColor: '#B8322A',
           borderWidth: 1.2, pointRadius: 0, tension: 0});
  ds.push({label: 'Порог внимания 15', data: labels.map(() => 15), borderColor: '#D99A12',
           borderWidth: 1.2, pointRadius: 0, tension: 0});
  chart = new Chart(el, {
    type: 'line', data: {labels, datasets: ds},
    options: {
      responsive: true, maintainAspectRatio: false, interaction: {mode: 'index', intersect: false},
      scales: {
        x: {ticks: {maxTicksLimit: 9, callback(v) { const s = this.getLabelForValue(v); return fmtShort(s); }}},
        y: {beginAtZero: true, title: {display: true, text: 'мкг/л'}},
      },
      plugins: {legend: {display: false}},
    },
  });
}

async function loadPanel(id) {
  const wb = S.byId[id];
  if (!wb) return;
  const t = ++S.histToken;
  const body = $('#panelBody');
  if (body) body.innerHTML = skeletonHTML(wb);
  const panel = $('#panel'); if (panel) panel.hidden = false;
  const note = $('#mapnote'); if (note) note.hidden = true;
  setBusy('#panelBody', true);
  const [pr, hr] = await Promise.allSettled([
    getPredict(id, S.date, S.mode),
    getHistory(id, S.mode, S.date, S.limit),
  ]);
  if (t !== S.histToken) return;
  const predRes = pr.status === 'fulfilled' ? {ok: true, d: pr.value} : {ok: false, err: pr.reason};
  S.res[id] = predRes;
  paintLakes();
  renderPanel(wb, predRes, hr.status === 'fulfilled' ? {ok: true, d: hr.value} : {ok: false, err: hr.reason});
  setBusy('#panelBody', false);
}

function selectLake(id) {
  if (!S.byId[id]) return;
  S.selected = id;
  paintLakes(); hideSuggest(); focusLake(id);
  const inp = $('#q'); if (inp) inp.value = '';
  loadPanel(id);
}
function closePanel() {
  S.selected = null;
  const panel = $('#panel'); if (panel) panel.hidden = true;
  const note = $('#mapnote'); if (note) note.hidden = false;
  paintLakes();
}

/* ---------------- поиск ---------------- */
function hideSuggest() { const s = $('#suggest'); if (s) { s.hidden = true; s.innerHTML = ''; } }
function showSuggest(q) {
  const s = $('#suggest'); if (!s) return;
  const needle = q.trim().toLowerCase();
  if (!needle) return hideSuggest();
  const hits = S.lakes.filter(w => (w.name + ' ' + w.id).toLowerCase().includes(needle)).slice(0, 8);
  s.innerHTML = hits.length
    ? hits.map(w => `<button type="button" class="suggest-item" data-id="${esc(w.id)}" role="option">
        ${esc(w.name)}<small>${esc(w.id)}${w.modes && w.modes.length ? ' · ' + w.modes.map(modeLabel).join(' / ') : ''}</small></button>`).join('')
    : '<div class="suggest-item" aria-disabled="true">Ничего не найдено</div>';
  s.hidden = false;
  const q2 = $('#q'); if (q2) q2.setAttribute('aria-expanded', 'true');
}
function onSuggestClick(e) {
  const b = e.target.closest('[data-id]');
  if (!b) return;
  selectLake(b.dataset.id);
  const q = $('#q'); if (q) q.value = '';
}

/* ---------------- режим и даты ---------------- */
function setMode(mode) {
  if (!MODES[mode] || mode === S.mode) return;
  S.mode = mode;
  document.querySelectorAll('#modeSwitch .seg').forEach(b => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  S.res = {};
  cache.clear();
  loadAll(S.date);
}

function shiftDecade(iso, dir) {
  let [y, m, d] = (iso || new Date().toISOString().slice(0, 10)).split('-').map(Number);
  let i = DECADES.indexOf(d);
  if (i < 0) i = d < 11 ? 0 : d < 21 ? 1 : 2;
  i += dir;
  if (i < 0) { i = 2; m--; if (m < 1) { m = 12; y--; } }
  if (i > 2) { i = 0; m++; if (m > 12) { m = 1; y++; } }
  return `${y}-${String(m).padStart(2, '0')}-${String(DECADES[i]).padStart(2, '0')}`;
}

/* ---------------- метрики ---------------- */
function flattenMetrics(m, path = []) {
  const rows = [];
  const MK = ['rmse', 'mae', 'r2', 'accuracy', 'precision', 'recall', 'f1', 'roc_auc'];
  if (m && typeof m === 'object' && !Array.isArray(m)) {
    const leaf = {};
    Object.entries(m).forEach(([k, v]) => { if (MK.includes(k.toLowerCase()) && typeof v === 'number') leaf[k.toLowerCase()] = Math.round(v * 1e4) / 1e4; });
    if (Object.keys(leaf).length) rows.push({group: path.join(' / ') || 'модель', metrics: leaf});
    Object.entries(m).forEach(([k, v]) => { if (v && typeof v === 'object' && !Array.isArray(v)) rows.push(...flattenMetrics(v, [...path, k])); });
  }
  return rows;
}
function qualitySummary(q) {
  if (!q) return '<p class="hint">Отчёт качества данных не передан Частью 1.</p>';
  const num = v => typeof v === 'number' ? fmtNum(v, 1) : esc(v);
  const skip = new Set(['per_lake', 'per_water_body', 'lakes']);
  const entries = Object.entries(q).filter(([k, v]) => !skip.has(k) && (typeof v === 'number' || typeof v === 'string'));
  return entries.length ? `<dl class="quality">${entries.slice(0, 16).map(([k, v]) =>
    `<dt>${esc(k)}</dt><dd>${num(v)}</dd>`).join('')}</dl>` : '<p class="hint">Отчёт качества пуст.</p>';
}
function renderMetrics(m) {
  const rows = flattenMetrics(m);
  const cols = ['rmse', 'mae', 'r2', 'accuracy', 'precision', 'recall', 'f1', 'roc_auc'].filter(k => rows.some(r => k in r.metrics));
  const name = {rmse: 'RMSE', mae: 'MAE', r2: 'R²', accuracy: 'Accuracy', precision: 'Precision', recall: 'Recall', f1: 'F1', roc_auc: 'ROC-AUC'};
  const table = rows.length
    ? `<div class="tw"><table><thead><tr><th>Модель / задача</th>${cols.map(k => `<th>${name[k]}</th>`).join('')}</tr></thead>
       <tbody>${rows.map(r => `<tr><td>${esc(r.group)}</td>${cols.map(k => `<td>${k in r.metrics ? r.metrics[k] : '—'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : '<p class="hint">Метрики появятся после подключения Части 2 (файл model_metrics.json).</p>';
  const modes = m.modes ? `<h3>Доступность режимов</h3><ul class="list">${Object.entries(m.modes).map(([k, v]) =>
    `<li><b>${esc(modeLabel(k))}</b>: <span class="pill ${v.available ? 'on' : 'off'}">${v.available ? 'доступен' : 'нет'}</span>
      ${v.data_file ? '· ' + esc(v.data_file) : ''}${v.models ? ' · ' + esc(v.models.join(', ')) : ''}${v.reason ? ' · ' + esc(v.reason) : ''}</li>`).join('')}</ul>` : '';
  $('#metrics').innerHTML = `<h3>Метрики моделей Части 2</h3>${table}${modes}
    <h3>Качество данных Части 1</h3>${qualitySummary(m.data_quality)}`;
}

async function openMetrics() {
  const modal = $('#metricsModal'); if (!modal) return;
  modal.hidden = false;
  $('#metrics').innerHTML = '<p class="hint">Загрузка…</p>';
  try { S.metrics = await api('/metrics'); renderMetrics(S.metrics); }
  catch (e) { $('#metrics').innerHTML = `<p class="hint">Метрики недоступны: ${esc(e.message)}</p>`; }
}

/* ---------------- загрузка пробы ---------------- */
async function submitLab(form) {
  const wbId = form.dataset.wb;
  const f = form.elements;
  const msg = $('#labMsg');
  const num = v => v === '' ? null : Number(v);
  const payload = {
    water_body_id: wbId,
    sample_date: f.sample_date.value,
    chl_a_lab_ug_l: num(f.chl.value),
    secchi_depth_m: num(f.secchi.value),
    total_phosphorus_ug_l: num(f.tp.value),
    source_note: f.note.value || 'Загружено через веб-панель',
  };
  if (msg) { msg.className = 'msg'; msg.textContent = 'Сохранение…'; }
  try {
    const r = await api('/lab/upload', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
    const cmp = r.satellite_comparison;
    if (msg) {
      msg.className = 'msg ok';
      msg.textContent = r.message + (cmp ? ` Спутник на ${cmp.satellite_date}: ${cmp.satellite_chl_a_ug_l} мкг/л (разница ${cmp.difference_ug_l > 0 ? '+' : ''}${cmp.difference_ug_l}).` : '');
    }
    form.reset();
  } catch (e) {
    if (msg) { msg.className = 'msg err'; msg.textContent = e.message; }
  }
}

/* ---------------- старт ---------------- */
async function syncLakes() {
  const lakes = await api('/lakes');
  S.lakes = lakes;
  S.byId = {};
  lakes.forEach(w => { S.byId[w.id] = w; });
  if (S.selected && !S.byId[S.selected]) closePanel();
  initMap();
  drawLakes();
}

async function init() {
  const note = $('#mapnote');
  if (note) note.hidden = false;
  loadStatus();
  try {
    await syncLakes();
  } catch (e) {
    showFatal(e.message);
    if (note) note.innerHTML = '<div><h2>API недоступен</h2><p>Не удалось получить список водоёмов.</p></div>';
    return;
  }
  if (!S.lakes.length) {
    if (note) note.innerHTML = '<div><h2>Список водоёмов пуст</h2><p>Проверьте реестр configs/water_bodies.yaml.</p></div>';
    return;
  }
  await loadAll(null);
  S.ready = true;
}

/* ---------------- события ---------------- */
const on = (sel, ev, fn) => { const e = $(sel); if (e) e.addEventListener(ev, fn); };
on('#modeSwitch', 'click', e => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });
on('#refresh', 'click', async () => {
  cache.clear();
  loadStatus(); S.metrics = null;
  try { await syncLakes(); } catch (e) { showFatal(e.message); return; }
  hideFatal();
  await loadAll(S.date);
});
on('#retry', 'click', () => { cache.clear(); init(); });
on('#prev', 'click', () => { if (S.date) { S.date = shiftDecade(S.date, -1); loadAll(S.date); } });
on('#next', 'click', () => { if (S.date) { S.date = shiftDecade(S.date, 1); loadAll(S.date); } });
on('#dinp', 'change', () => { const v = $('#dinp').value; if (v) { S.date = v; loadAll(v); } });
on('#q', 'input', () => showSuggest($('#q').value));
on('#q', 'keydown', e => {
  if (e.key === 'Escape') { hideSuggest(); $('#q').blur && $('#q').blur(); }
  if (e.key === 'Enter') { const b = $('#suggest') && $('#suggest').querySelector('[data-id]'); if (b) { e.preventDefault(); selectLake(b.dataset.id); } }
});
on('#suggest', 'click', onSuggestClick);
on('#metricsBtn', 'click', openMetrics);
on('#metricsClose', 'click', () => { const m = $('#metricsModal'); if (m) m.hidden = true; });
on('#metricsModal', 'click', e => { if (e.target && e.target.id === 'metricsModal') e.target.hidden = true; });
on('#panelBody', 'click', e => {
  const a = e.target.closest('[data-action]');
  if (a && a.dataset.action === 'close') closePanel();
});
on('#panelBody', 'change', e => {
  if (e.target.id === 'histWin') { S.limit = Number(e.target.value) || 36; if (S.selected) loadPanel(S.selected); }
});
on('#panelBody', 'submit', e => {
  if (e.target.id === 'labForm') { e.preventDefault(); submitLab(e.target); }
});

window.dashboardReady = init();
// небольшой хук для автотестов (Node harness): состояние и ключевые действия
window.__dash = {S, selectLake, closePanel, setMode, loadAll, init};
