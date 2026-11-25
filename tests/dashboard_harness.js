// Прогон скрипта панели в Node: имитация DOM/Leaflet/Chart.js, реальные HTTP-запросы к тестовому серверу.
// node tests/dashboard_harness.js <каталог frontend> <api-url> [dead]
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const [, , frontDir, base, mode] = process.argv;
const code = fs.readFileSync(frontDir + '/app.js', 'utf8');

const els = {};
class El {
  constructor(sel) {
    this.sel = sel; this.attrs = {}; this.ls = {}; this.innerHTML = ''; this.textContent = '';
    this.hidden = false; this.value = ''; this.dataset = {}; this.id = sel.replace(/^#/, ''); this.cl = new Set();
    this.classList = {
      toggle: (c, f) => { (f === undefined ? !this.cl.has(c) : f) ? this.cl.add(c) : this.cl.delete(c); },
      add: c => this.cl.add(c), remove: c => this.cl.delete(c), contains: c => this.cl.has(c),
    };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  addEventListener(t, f) { (this.ls[t] = this.ls[t] || []).push(f); }
  async fire(t, e = {}) { for (const f of this.ls[t] || []) await f({target: this, preventDefault() {}, ...e}); }
  querySelector(sel) { return get(this.sel + ' ' + sel); }
  closest() { return null; }
  reset() { }
  blur() { }
}
const get = sel => (els[sel] = els[sel] || new El(sel));
const segEls = ['satellite', 'lab'].map(m => { const e = new El('.seg'); e.dataset = {mode: m}; if (m === 'satellite') e.cl.add('active'); return e; });
globalThis.document = {querySelector: get, querySelectorAll: sel => (sel === '#modeSwitch .seg' ? segEls : [])};
globalThis.window = globalThis;
globalThis.location = {search: '?api=' + encodeURIComponent(base), protocol: 'http:', origin: 'http://unused'};

const layersLog = [];                                   // все созданные слои карты (полигоны и прямоугольники)
const bounds = () => ({getSouthWest: () => [0, 0], getNorthEast: () => [1, 1], extend() { return this; }});
const mkLayer = (kind, style) => {
  const r = {kind, style: {...style}, tip: '', removed: false, ls: {},
    addTo() { this.removed = false; return this; },
    on(ev, fn) { this.ls[ev] = fn; return this; },
    setStyle(s) { Object.assign(this.style, s); }, unbindTooltip() { return this; },
    bindTooltip(t) { this.tip = t; return this; }, getBounds: bounds};
  layersLog.push(r); return r;
};
globalThis.L = {
  map: () => ({fitBounds() {}, setView() {}, removeLayer(r) { r.removed = true; }}),
  tileLayer: () => ({addTo() { return this; }}),
  control: {layers: () => ({addTo() { return this; }})},
  rectangle: (b, o) => mkLayer('rectangle', o),
  geoJSON: (g, o) => { assert(g && g.type === 'Polygon', 'в слой передан полигон'); return mkLayer('geojson', o && o.style ? o.style() : {}); },
  latLngBounds: () => bounds()
};
globalThis.Chart = class { constructor(el, cfg) { this.el = el; this.data = cfg.data; this.options = cfg.options; globalThis.__chart = this; } destroy() {} };
const chartDs = label => (globalThis.__chart ? globalThis.__chart.data.datasets.find(d => d.label === label) : null);
for (const s of ['#stub', '#apierr', '#panel', '#metricsModal', '#suggest']) get(s).hidden = true;   // как в index.html

const sleep = ms => new Promise(r => setTimeout(r, ms));
const busy = () => get('#mapnote').attrs['aria-busy'] === 'true' || get('#panelBody').attrs['aria-busy'] === 'true';
async function idle() { for (let i = 0; i < 600; i++) { await sleep(10); if (!busy()) { await sleep(30); if (!busy()) return; } } throw new Error('timeout: загрузка не завершилась'); }
async function waitFor(fn, ms = 3000) { for (let t = 0; t < ms; t += 25) { if (fn()) return; await sleep(25); } throw new Error('timeout: условие не выполнено'); }
const J = async p => (await fetch(base + p)).json();
const log = () => J('/__log'), hlog = () => J('/__hlog'), hits = () => J('/__hits'), clear = () => fetch(base + '/__clear');
const count = (s, sub) => s.split(sub).length - 1;
const setDate = async v => { get('#dinp').value = v; await get('#dinp').fire('change'); await idle(); };
const panelText = () => get('#panelBody').innerHTML;

(async () => {
  vm.runInThisContext(code, {filename: 'dashboard-script'});
  await window.dashboardReady; await idle(); await sleep(50);

  if (mode === 'dead') {
    assert.strictEqual(get('#apierr').hidden, false, 'баннер ошибки связи должен показываться');
    assert(get('#apierr-msg').textContent.includes('Нет связи'));
    assert(get('#mapnote').innerHTML.includes('API недоступен'));
    await get('#retry').fire('click'); await sleep(150);
    assert.strictEqual(get('#apierr').hidden, false);
    return console.log('JS harness (сервер недоступен): OK');
  }

  // 1. Первая загрузка: /lakes + по одному /predict на озеро, полигоны на карте, дату выбирает сервер
  let l = await log();
  assert.strictEqual(l.length, 2, 'на старте — по одному /predict на водоём');
  assert(l.every(x => x.date === null && x.mode === 'satellite'));
  assert.strictEqual((await hits())['/lakes'], 1, 'перечень водоёмов запрошен через /lakes');
  assert.strictEqual(get('#dinp').value, '2026-08-01');
  assert.strictEqual(layersLog.length, 2);
  assert(layersLog.every(x => x.kind === 'geojson'), 'озёра рисуются по полигонам');
  assert(layersLog[0].tip.includes('Заславское'));
  assert.strictEqual(get('#stub').hidden, false);
  assert(get('#stub span').textContent.includes('Тестовые данные'));
  assert(get('#sub').textContent.includes('Спутник') && get('#sub').textContent.includes('10 дней'));
  assert(get('#upd').textContent.includes('Данные с сервера'));
  assert.strictEqual(get('#panel').hidden, true, 'панель закрыта, пока озеро не выбрано');

  // 2. Клик по озеру: панель с паспортом, текущими метриками, прогнозом, TSI, причинами и графиком
  await window.__dash.selectLake('zaslavskoe'); await idle();
  let p = panelText();
  assert.strictEqual(get('#panel').hidden, false);
  for (const s of ['Заславское', 'Паспорт водоёма', 'Площадь', 'км²', 'Хлорофилл-а сейчас',
    'Индекс Карлсона', 'Трофический класс', 'Прогноз на 10 дней', 'Причины и рекомендации',
    'Качество и доступность данных', 'История наблюдений', 'Доступные режимы'])
    assert(p.includes(s), 'в панели нет: ' + s);
  assert(p.includes('Интервал ±3'), 'интервал ±MAE из model_metrics.json');
  assert(p.includes('Риск цветения'));
  assert(!p.includes('Добавить лабораторную пробу'), 'в спутниковом режиме формы пробы нет');
  assert(p.includes('Значения не являются реальными'), 'честная оговорка про демо-данные');
  assert.strictEqual((await log()).length, 2, 'прогноз взят из кеша, повторного /predict нет');
  assert.strictEqual((await hlog()).length, 1, 'история запрошена один раз');
  let h = (await hlog())[0];
  assert.strictEqual(h.mode, 'satellite'); assert.strictEqual(h.limit, 36); assert.strictEqual(h.wb, 'zaslavskoe');
  assert.strictEqual(globalThis.__chart.data.labels.length, 36);
  assert.strictEqual(globalThis.__chart.data.labels.at(-1), '2026-08-01');
  assert.strictEqual(chartDs('Наблюдения').data.length, 36);
  assert(chartDs('Прогноз +10 сут'));
  assert.strictEqual(chartDs('Порог цветения 25').data.every(v => v === 25), true);
  assert.strictEqual(chartDs('Порог внимания 15').data.every(v => v === 15), true);
  assert(chartDs('Коридор ±MAE') && chartDs('Коридор ±MAE').data.some(v => v != null), 'полоса ±MAE на графике');

  // 3. Опасная дата: контур и бейдж красные, причины и рекомендации заполнены
  await setDate('2025-07-01');
  p = panelText();
  assert(p.includes('Опасность'), 'на 2025-07-01 Заславское — RED');
  assert(p.includes('превышает порог 25'));
  assert(p.includes('Усилить отбор проб'));
  assert.strictEqual(layersLog[0].style.color, '#B8322A', 'контур Заславского красный');

  // 4. Переключатель Спутник/Лаборатория: меняются запросы, подпись, данные и форма пробы
  await window.__dash.setMode('lab'); await idle();
  assert.strictEqual(vm.runInThisContext('S.mode'), 'lab');
  assert(segEls[1].cl.has('active') && !segEls[0].cl.has('active'));
  l = await log();
  assert(l.slice(-2).every(x => x.mode === 'lab'), 'после переключения запросы идут с mode=lab');
  assert.strictEqual((await hlog()).at(-1).mode, 'lab');
  p = panelText();
  assert(p.includes('Лаборатория'), 'подпись источника в панели');
  assert(p.includes('Добавить лабораторную пробу'), 'в лабораторном режиме есть форма');
  assert.strictEqual(get('#sub').textContent.includes('Лаборатория'), true);
  assert.strictEqual(globalThis.__chart.data.labels.at(-1), '2025-07-01');
  assert.strictEqual(vm.runInThisContext('S.res.zaslavskoe.d.mode'), 'lab');

  // 5. Загрузка лабораторной пробы: сохранение, дубль и физический диапазон
  const mkForm = (chl) => {
    const f = new El('#labForm');
    f.elements = {sample_date: {value: '2025-07-05'}, chl: {value: chl}, secchi: {value: '1.8'},
      tp: {value: '42'}, note: {value: 'тест панели'}};
    f.dataset = {wb: 'zaslavskoe'};
    return f;
  };
  await get('#panelBody').fire('submit', {target: mkForm('18.5')});
  await waitFor(() => get('#labMsg').textContent.includes('Проба сохранена'));
  assert(get('#labMsg').textContent.includes('Проба сохранена'));
  assert(!get('#labMsg').className.includes('err'));
  await get('#panelBody').fire('submit', {target: mkForm('19')});
  await waitFor(() => get('#labMsg').textContent.includes('уже есть'));
  assert(get('#labMsg').className.includes('err'), 'дубль отклонён с ошибкой');
  await get('#panelBody').fire('submit', {target: mkForm('5000')});
  await waitFor(() => get('#labMsg').textContent.includes('диапазона'));
  assert(get('#labMsg').className.includes('err'), 'значение вне диапазона отклонено');

  // 6. Поиск: подсказки и переход к озеру
  get('#q').value = 'нар'; await get('#q').fire('input');
  assert.strictEqual(get('#suggest').hidden, false);
  assert(get('#suggest').innerHTML.includes('Нарочь'));
  await get('#suggest').fire('click', {target: {closest: () => ({dataset: {id: 'naroch'}})}});
  await idle();
  assert.strictEqual(vm.runInThisContext('S.selected'), 'naroch');
  assert(panelText().includes('Нарочь'));
  assert.strictEqual(get('#panel').hidden, false);

  // 7. Окно истории: меньше декад — короче график и другой запрос
  await get('#panelBody').fire('change', {target: {id: 'histWin', value: '12'}}); await idle();
  assert.strictEqual((await hlog()).at(-1).limit, 12);
  assert.strictEqual(globalThis.__chart.data.labels.length, 12);

  // 8. Нет наблюдения: зима, облачность, интерполяция — прогноз не выдумывается
  await setDate('2025-01-11');
  p = panelText();
  assert(p.includes('ледяной') || p.includes('Ледяной'));
  assert(p.includes('Прогноз не рассчитан'));
  assert.strictEqual(layersLog[1].style.color, '#7A8E96', 'без наблюдения контур серый');
  assert(chartDs('Прогноз +10 сут').data.slice(-4).every(v => v == null), 'на ледяных декадах прогноза нет');
  await setDate('2025-06-21');
  assert(panelText().includes('Облачность'));
  await setDate('2025-09-01');
  assert(panelText().includes('восстановлено интерполяцией'));
  assert(!panelText().includes('Прогноз не рассчитан'));

  // 9. Ошибки: дата вне данных (404) и некорректная дата (422) — панель объясняет, карта серая
  await setDate('2035-05-01');
  assert(panelText().includes('Нет данных') && panelText().includes('Диапазон'));
  assert.strictEqual(get('#apierr').hidden, true, '404 — не ошибка связи');
  assert(layersLog.every(x => x.style.color === '#7A8E96'));
  get('#dinp').value = '2025-13-45'; await get('#dinp').fire('change'); await idle();
  assert(panelText().includes('Нет данных'));

  // 10. Гонка запросов: побеждает последняя выбранная дата
  await setDate('2025-05-21');
  get('#dinp').value = '2025-06-01'; const p1 = get('#dinp').fire('change');
  get('#dinp').value = '2025-07-01'; const p2 = get('#dinp').fire('change');
  await Promise.all([p1, p2]); await idle();
  assert.strictEqual(vm.runInThisContext('S.date'), '2025-07-01');
  assert.strictEqual(globalThis.__chart.data.labels.at(-1), '2025-07-01');

  // 11. Метрики: таблица моделей, доступность режимов, отчёт качества
  await get('#metricsBtn').fire('click'); await sleep(120);
  assert.strictEqual(get('#metricsModal').hidden, false);
  const met = get('#metrics').innerHTML;
  for (const s of ['RMSE', 'MAE', 'R²', 'Доступность режимов', 'Качество данных', 'valid_share', 'pill on'])
    assert(met.includes(s), 'в метриках нет: ' + s);
  await get('#metricsClose').fire('click');
  assert.strictEqual(get('#metricsModal').hidden, true);

  // 12. Добавление озера при работающем сервере: «Обновить» перезапрашивает /lakes и перерисовывает карту
  await clear(); const h0 = (await hits())['/lakes'] || 0;
  await fetch(base + '/__add_lake'); const layers0 = layersLog.length;
  await get('#refresh').fire('click'); await idle();
  assert.strictEqual((await hits())['/lakes'], h0 + 1, 'перечень водоёмов запрошен заново');
  assert.strictEqual(vm.runInThisContext('S.lakes.length'), 3);
  assert.strictEqual(layersLog.length - layers0, 3, 'слои карты пересозданы по новому перечню');
  await fetch(base + '/__remove_lake'); await get('#refresh').fire('click'); await idle();
  assert.strictEqual(vm.runInThisContext('S.lakes.length'), 2);

  // 13. Озеро без полигона рисуется прямоугольником BBox
  await fetch(base + '/__add_lake?nogeo=1'); const k0 = layersLog.length;
  await get('#refresh').fire('click'); await idle();
  assert(layersLog.slice(k0).some(x => x.kind === 'rectangle'), 'без полигона — прямоугольник');
  await fetch(base + '/__remove_lake'); await get('#refresh').fire('click'); await idle();

  console.log('JS harness: OK');
})().catch(e => { console.error('FAIL:', e.stack || e); process.exit(1); });
