"""Общий конвейер Части 4: срез признаков -> модели -> граф знаний -> словарь ответа.
Используется API (main.py), скриптами проверки и тестами, поэтому здесь нет FastAPI.

build_components(): для каждой части, если её файлы найдены, подключается РЕАЛЬНЫЙ компонент
(ошибка в найденном файле не скрывается!), если файлов нет — заглушка из stubs.py.
refresh_part1(): перечитывает реестр, витрины и полигоны при изменении файлов (добавлено озеро).
Поддерживаются оба режима DATA_CONTRACT.md: satellite (features_satellite) и lab (features_lab).
"""
import importlib.util
import os
import sys
import threading
from datetime import date
from typing import Dict, List, Optional, Tuple

from src.api import adapters, config, stubs

HORIZON_DAYS = 10
MODES = config.MODES
PART_NAMES = {"part1": "Часть 1 (данные)", "part2": "Часть 2 (модели)", "part3": "Часть 3 (граф знаний)"}

# Декады без надёжного наблюдения: прогноз не строится, значения не придумываются.
NO_OBSERVATION = {"ice_cover", "cloudy_missing", "insufficient_pixels"}
NO_OBSERVATION_TEXT = {
    "ice_cover": "Ледяной покров: наблюдения нет, прогноз не строится",
    "cloudy_missing": "Облачность: чистых наблюдений за декаду нет, прогноз не строится",
    "insufficient_pixels": "Недостаточно чистых пикселей воды: прогноз не строится",
}
DEMO_SOURCE = "Демонстрационные данные (заглушка): реальные Части 1–3 не подключены"
DEMO_NOTE = "Значения не являются реальными измерениями и результатом обученных моделей."


class ModeUnavailable(adapters.ModeUnavailable):
    """Режим недоступен для этого водоёма/проекта."""


def _module_available(name: str) -> bool:
    if name in sys.modules:
        return True
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def _missing(what: str) -> str:
    if config.strict():
        raise FileNotFoundError(f"WATER_STRICT=1, но не найдено: {what}")
    return f"заглушка (нет: {what})"


def _is_real(c: dict, part: str) -> bool:
    return str(c["status"].get(part, "")).startswith("реальная")


def _load_part1():
    """Реестр водоёмов (+ полигоны) и провайдеры данных для каждого режима. Ошибки не скрываются."""
    reg_path = config.find_registry()
    feat_paths = {mode: config.find_features(mode) for mode in MODES}
    if not reg_path or not any(feat_paths.values()):
        raise FileNotFoundError("не найдены water_bodies.yaml и/или витрины признаков")
    registry = adapters.load_registry(reg_path)
    providers: Dict[str, adapters.RealDataProvider] = {}
    paths: Dict[str, Optional[str]] = {}
    for mode, feat_path in feat_paths.items():
        paths[mode] = feat_path.name if feat_path else None
        if feat_path:
            chl_override = os.environ.get("WATER_CHL_COLUMN_LAB" if mode == "lab" else "WATER_CHL_COLUMN")
            providers[mode] = adapters.RealDataProvider(feat_path, registry, chl_override, mode)
    geo_path = config.find_geometry()
    if geo_path:
        geoms = adapters.load_geometry(geo_path)
        for wb_id, wb in registry.items():
            wb["geometry"] = geoms.get(wb_id)
    return registry, providers, paths


def _load_predictors() -> Dict[str, dict]:
    """Модели Части 2 по режимам (режим без моделей просто не попадает в словарь)."""
    out: Dict[str, dict] = {}
    for mode in MODES:
        models = config.find_models(mode)
        if models:
            out[mode] = dict(predictor=adapters.RealPredictor(*models, config.find_attention_model(mode)),
                             names=tuple(p.name for p in models), real=True)
    return out


def build_components() -> dict:
    c, status = {"lock": threading.Lock(), "reload_error": None}, {}

    # Часть 1: реестр водоёмов + полигоны + витрины признаков
    try:
        c["registry"], c["providers"], c["paths"] = _load_part1()
        status["part1"] = "реальная: " + ", ".join(
            x for x in [config.find_registry().name] + [v for v in c["paths"].values() if v] if x)
    except FileNotFoundError:
        c["registry"], c["providers"], c["paths"] = stubs.WATER_BODIES, \
            {mode: stubs.StubDataProvider(mode) for mode in MODES}, {mode: None for mode in MODES}
        status["part1"] = _missing("water_bodies.yaml и витрина признаков (features_satellite / features_lab)")
    c["provider"] = c["providers"].get("satellite") or next(iter(c["providers"].values()), None)
    c["fp1"] = config.part1_fingerprint()
    c["status"] = status

    # Часть 2: модели (нужны реальные данные режима, чтобы было на чём предсказывать)
    real_pred = _load_predictors() if _is_real(c, "part1") else {}
    c["predictors"] = {}
    for mode in MODES:
        if mode in real_pred and mode in c["providers"]:
            c["predictors"][mode] = real_pred[mode]
        else:
            c["predictors"][mode] = dict(predictor=stubs.StubPredictor(mode), names=("заглушка",), real=False)
    sat = c["predictors"]["satellite"]
    if sat["real"]:
        status["part2"] = "реальная: " + ", ".join(sat["names"])
    elif real_pred:
        status["part2"] = "заглушка (модели есть, но нет реальной витрины нужного режима)"
    else:
        status["part2"] = _missing("модели .joblib")
    c["predictor"] = sat["predictor"]

    # метрики и отчёт качества
    metrics_path = config.find_metrics()
    c["metrics"] = adapters.load_metrics(metrics_path) if metrics_path else stubs.STUB_METRICS
    c["metrics_path"] = metrics_path
    c["quality"] = adapters.load_quality(config.find_quality())

    # Часть 3: машина логического вывода
    if _module_available(config.ENGINE_MODULE):
        c["engine"] = adapters.RealGraphEngine(config.ENGINE_MODULE, config.find_ontology())
        status["part3"] = f"реальная: {config.ENGINE_MODULE}.{c['engine'].describe()}"
    else:
        c["engine"] = stubs.StubGraphEngine()
        status["part3"] = _missing(config.ENGINE_MODULE)

    c["status"] = status
    c["stub_parts"] = [PART_NAMES[k] for k in PART_NAMES if str(status[k]).startswith("заглушка")]
    return c


def refresh_part1(c: dict) -> None:
    """Если файлы реестра/витрин/полигонов изменились (добавлено озеро), перечитывает их без перезапуска.
    Модели и граф знаний не перезагружаются. Ошибка чтения не ломает работу: остаётся прежний набор,
    причина попадает в c['reload_error'] (её показывает маршрут «/»)."""
    if not _is_real(c, "part1"):
        return
    fp = config.part1_fingerprint()
    if fp == c["fp1"]:
        return
    with c["lock"]:
        if fp == c["fp1"]:
            return
        c["fp1"] = fp                      # не повторяем попытку на каждом запросе, пока файлы не изменятся
        try:
            c["registry"], c["providers"], c["paths"] = _load_part1()
            c["provider"] = c["providers"].get("satellite") or next(iter(c["providers"].values()), None)
            c["reload_error"] = None
        except Exception as e:             # noqa: BLE001 - сообщаем причину, прежние данные остаются
            c["reload_error"] = f"{type(e).__name__}: {e}"


# ------------------------------------------------------------------ вспомогательное
def modes_for(c: dict, wb_id: str) -> List[str]:
    """Режимы, в которых для озера есть и данные, и модель."""
    out = []
    for mode in MODES:
        prov = c["providers"].get(mode)
        if prov is not None and prov.supports(wb_id) and c["predictors"][mode]["real"]:
            out.append(mode)
    if not out and not _is_real(c, "part1"):   # заглушки: оба режима доступны для демонстрации
        out = [m for m in MODES if c["providers"].get(m) is not None and c["providers"][m].supports(wb_id)]
    return out or ["satellite"]


def _walk_numbers(obj, path: Tuple[str, ...] = ()):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield from _walk_numbers(v, path + (str(k),))
    elif isinstance(obj, (int, float)) and not isinstance(obj, bool):
        yield path, float(obj)


def model_mae(c: dict, mode: str) -> Optional[float]:
    """±MAE регрессии из model_metrics.json (структура произвольная — ищем по имени ключа)."""
    hits = [(p, v) for p, v in _walk_numbers(c.get("metrics") or {}) if p and p[-1].lower() == "mae" and v > 0]
    if not hits:
        return None
    mode_words = ("lab", "laboratory", "пробир") if mode == "lab" else ("sat", "space", "спутник")
    weighted = [h for h in hits if any(w in " ".join(h[0]).lower() for w in mode_words)]
    chl_like = [h for h in (weighted or hits) if any(w in " ".join(h[0]).lower() for w in ("chl", "chlor", "10d", "regress"))]
    return (chl_like or weighted or hits)[0][1]


def _base_sources(c: dict, mode: str, f: dict) -> List[str]:
    if not _is_real(c, "part1") or not c["predictors"][mode]["real"]:
        return [DEMO_SOURCE]
    src = [f"{f.get('source') or ('Sentinel-2 L2A (ESA/Copernicus)' if mode == 'satellite' else 'Лабораторная проба')}"]
    if f.get("temp_mean_14d") is not None or f.get("calm_fraction_7d") is not None:
        src.append("NASA POWER — суточная погода, окна 7/14/21 день")
    src.append("Модели Части 2: " + ", ".join(c["predictors"][mode]["names"]))
    if _is_real(c, "part3"):
        src.append("Граф знаний W3C SOSA/SSN (Часть 3)")
    if f.get("source_note"):
        src.append(f"Примечание к пробе: {f['source_note']}")
    return src


def _base_notes(c: dict, mode: str, f: dict) -> List[str]:
    if not _is_real(c, "part1") or not c["predictors"][mode]["real"]:
        return [DEMO_NOTE]
    return []


def _observation(f: dict, demo: bool) -> dict:
    return dict(date=f["date_used"], obs_status=f.get("obs_status"),
                is_interpolated=bool(f.get("is_interpolated")),
                scenes_in_decade=None if demo else f.get("scenes_in_decade"),
                valid_water_pixels=None if demo else f.get("valid_water_pixels"),
                source=(DEMO_SOURCE if demo else f.get("source")),
                scene_id=None if demo else f.get("scene_id"))


# ------------------------------------------------------------------ основные сценарии
def run_pipeline(c: dict, wb_id: str, requested: date, mode: str = "satellite") -> Optional[dict]:
    """Возвращает словарь полей AlertResponse или None, если на дату нет данных.
    ModeUnavailable — если для режима нет витрины/модели/данных по этому озеру."""
    if mode not in MODES:
        raise ValueError(f"Неизвестный режим '{mode}'. Допустимо: {', '.join(MODES)}")
    wb = c["registry"][wb_id]
    provider = c["providers"].get(mode)
    if provider is None or not provider.supports(wb_id):
        raise ModeUnavailable(f"Режим '{mode}' недоступен для водоёма '{wb_id}': нет данных этого режима")
    f = provider.get_features(wb_id, requested)
    if f is None:
        return None
    demo = not _is_real(c, "part1")
    pred = c["predictors"][mode]
    status = f.get("obs_status")
    result = dict(
        water_body_id=wb_id, water_body_name=wb["name"], mode=mode, requested_date=requested,
        date_used=f["date_used"], horizon_days=HORIZON_DAYS, obs_status=status,
        is_interpolated=bool(f.get("is_interpolated")),
        temp_mean_14d=f["temp_mean_14d"], calm_fraction_7d=f["calm_fraction_7d"],
        observation=_observation(f, demo), sources=_base_sources(c, mode, f),
        notes=_base_notes(c, mode, f))

    if status in NO_OBSERVATION:                                   # наблюдения нет: ничего не придумываем
        return {**result, "chl_a_current": None, "chl_a_forecast": None,
                "pred_low_ug_l": None, "pred_high_ug_l": None, "uncertainty_ug_l": None,
                "bloom_probability": None, "attention_probability": None,
                "trophic_index": None, "trophic_class": None, "alert_level": None,
                "reasons": [NO_OBSERVATION_TEXT.get(status, f"Нет наблюдения ({status}): прогноз не строится")],
                "recommendations": []}

    if not pred["real"] and not demo:
        return {**result, "chl_a_current": f["chl_a_current"], "chl_a_forecast": None,
                "pred_low_ug_l": None, "pred_high_ug_l": None, "uncertainty_ug_l": None,
                "bloom_probability": None, "attention_probability": None,
                "trophic_index": None, "trophic_class": None, "alert_level": None,
                "reasons": [f"Прогноз недоступен: модель режима '{mode}' не подключена (Часть 2)"],
                "recommendations": []}

    chl, prob, att = _predict_one(pred["predictor"], f)            # Часть 2
    mae = model_mae(c, mode)
    low = high = None
    notes = list(result["notes"])
    if mae is not None:
        low, high = round(max(chl - mae, 0.0), 2), round(chl + mae, 2)
    else:
        notes.append("В model_metrics.json нет MAE — доверительный интервал не рассчитан.")
    v = c["engine"].assess(wb_id, wb["name"], f["date_used"], chl, prob,   # Часть 3
                           f["temp_mean_14d"], f["calm_fraction_7d"])
    return {**result, "chl_a_current": f["chl_a_current"], "chl_a_forecast": chl,
            "pred_low_ug_l": low, "pred_high_ug_l": high, "uncertainty_ug_l": mae,
            "bloom_probability": prob, "attention_probability": att,
            "trophic_index": v.trophic_index, "trophic_class": v.trophic_class, "alert_level": v.alert_level,
            "reasons": v.reasons, "recommendations": v.recommendations, "notes": notes}


def _predict_one(predictor, f: dict):
    out = predictor.predict(f)
    return out if len(out) == 3 else (out[0], out[1], None)


def history(c: dict, wb_id: str, mode: str = "satellite", end: Optional[date] = None,
            limit: int = 120) -> dict:
    """Ряд наблюдений + прогноз модели на +10 дней от каждой декады (для графика)."""
    if mode not in MODES:
        raise ValueError(f"Неизвестный режим '{mode}'. Допустимо: {', '.join(MODES)}")
    provider = c["providers"].get(mode)
    if provider is None or not provider.supports(wb_id):
        raise ModeUnavailable(f"Режим '{mode}' недоступен для водоёма '{wb_id}': нет данных этого режима")
    demo = not _is_real(c, "part1")
    end = end or config.DEFAULT_DATE
    frame = provider.history_frame(wb_id, end, limit=limit)
    notes = []
    if demo:
        notes.append(DEMO_NOTE)
    elif not c["predictors"][mode]["real"]:
        notes.append("Модель режима не подключена: на графике только наблюдения, прогноз не строится.")
    preds = []
    if not frame.empty and (c["predictors"][mode]["real"] or demo):
        try:
            preds = c["predictors"][mode]["predictor"].predict_many(frame)
        except Exception as e:             # noqa: BLE001 — историю без прогноза показываем честно
            notes.append(f"Прогноз для истории недоступен: {type(e).__name__}: {e}")
    mae = model_mae(c, mode) if preds else None
    points = []
    for i, (_, row) in enumerate(frame.iterrows()):
        m = provider.row_meta(row)
        has_obs = m["obs_status"] not in NO_OBSERVATION and m["chl_a_current"] is not None
        out = preds[i] if i < len(preds) else None
        forecast = out[0] if (out and has_obs) else None
        points.append(dict(date=m["date"], observed=m["chl_a_current"], obs_status=m["obs_status"],
                           is_interpolated=m["is_interpolated"], forecast=forecast,
                           forecast_low=None if forecast is None or mae is None else round(max(forecast - mae, 0), 2),
                           forecast_high=None if forecast is None or mae is None else round(forecast + mae, 2)))
    src = _base_sources(c, mode, dict(source=None, temp_mean_14d=1, calm_fraction_7d=None)) if not demo \
        else [DEMO_SOURCE]
    return dict(water_body_id=wb_id, mode=mode, horizon_days=HORIZON_DAYS, points=points,
                sources=src, notes=notes)


def mode_catalog(c: dict) -> dict:
    """Что реально доступно по каждому режиму (для /metrics и панели)."""
    out = {}
    for mode in MODES:
        prov = c["providers"].get(mode)
        pred = c["predictors"][mode]
        lakes = [w for w in c["registry"] if prov is not None and prov.supports(w)]
        reason = None
        if prov is None:
            reason = "нет витрины признаков режима"
        elif not pred["real"] and _is_real(c, "part1"):
            reason = "нет обученных моделей режима"
        out[mode] = dict(available=bool(lakes) and (pred["real"] or not _is_real(c, "part1")),
                         data_file=c["paths"].get(mode), models=list(pred["names"]) if pred["real"] else None,
                         lakes=lakes, reason=reason)
    return out
