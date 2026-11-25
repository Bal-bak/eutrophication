"""
Переходники к РЕАЛЬНЫМ компонентам Частей 1-3. Интерфейсы такие же, как у заглушек в stubs.py.
Вся «догадливость» про чужие форматы сосредоточена здесь: если что-то не подойдёт,
правится только этот файл, а API и дашборд не трогаем.

Поддерживаются оба режима DATA_CONTRACT.md:
  features_satellite.parquet — спутниковый (chl_a_est_current)
  features_lab.parquet       — лабораторный (chl_a_lab_ug_l)
"""
from __future__ import annotations

import importlib
import inspect
import json
import math
from datetime import date
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import joblib
import pandas as pd
import yaml

from src.api.stubs import AlertVerdict


class IntegrationError(RuntimeError):
    """Файл или компонент другой части не соответствует ожидаемому контракту."""


class ModeUnavailable(RuntimeError):
    """Для выбранного режима нет данных или модели (честно сообщаем, а не подставляем другое)."""


def _num(x) -> Optional[float]:
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(x) else x


def _int(x) -> Optional[int]:
    v = _num(x)
    return None if v is None else int(round(v))


# ------------------------------------------------------------------ Часть 1
def _first(d: dict, keys, default=None):
    for k in keys:
        if k in d and d[k] is not None:
            return d[k]
    return default


def _norm_bbox(raw) -> Optional[dict]:
    """BBox как словарь или список из 4 чисел в любом порядке (широта 50-57, долгота 22-34)."""
    if isinstance(raw, dict):
        g = lambda ks: _num(_first(raw, ks))
        b = dict(min_lat=g(["min_lat", "south", "lat_min", "miny"]), min_lon=g(["min_lon", "west", "lon_min", "minx"]),
                 max_lat=g(["max_lat", "north", "lat_max", "maxy"]), max_lon=g(["max_lon", "east", "lon_max", "maxx"]))
        return b if all(v is not None for v in b.values()) else None
    if isinstance(raw, (list, tuple)) and len(raw) == 4:
        nums = [_num(x) for x in raw]
        lats = [x for x in nums if x is not None and 50 <= x <= 57]
        lons = [x for x in nums if x is not None and 22 <= x <= 34]
        if len(lats) == 2 and len(lons) == 2:
            return dict(min_lat=min(lats), min_lon=min(lons), max_lat=max(lats), max_lon=max(lons))
    return None


def load_registry(path: Path) -> Dict[str, dict]:
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
    if isinstance(raw, dict) and "water_bodies" in raw:
        raw = raw["water_bodies"]
    if isinstance(raw, dict):
        raw = [({"id": k, **v} if isinstance(v, dict) else {"id": k}) for k, v in raw.items()]
    if not isinstance(raw, list):
        raise IntegrationError(f"{path}: не понял структуру реестра водоёмов")
    out: Dict[str, dict] = {}
    for e in raw:
        flat = dict(e)
        for nested in ("morphometry", "coordinates", "location"):
            if isinstance(e.get(nested), dict):
                flat.update(e[nested])
        wb_id = _first(flat, ["id", "water_body_id", "code"])
        if wb_id is None:
            raise IntegrationError(f"{path}: у водоёма нет id: {list(flat)[:8]}")
        bbox = _norm_bbox(_first(flat, ["bbox", "BBox", "bounding_box"]))
        lat = _num(_first(flat, ["center_lat", "lat", "latitude"]))
        lon = _num(_first(flat, ["center_lon", "lon", "lng", "longitude"]))
        if (lat is None or lon is None) and bbox:
            lat, lon = (bbox["min_lat"] + bbox["max_lat"]) / 2, (bbox["min_lon"] + bbox["max_lon"]) / 2
        eco = flat.get("ecological_context") if isinstance(flat.get("ecological_context"), dict) else {}
        protected = _first(flat, ["protected_area", "oopt", "protection"])
        if protected is None and eco:
            protected = _first(eco, ["protected_area", "oopt", "status"])
        area = _num(_first(flat, ["area_km2", "area"]))
        watershed = _num(_first(flat, ["watershed_km2", "catchment_km2", "watershed_area_km2"]))
        ratio = _num(_first(flat, ["watershed_ratio", "catchment_ratio"]))
        if ratio is None and watershed and area:
            ratio = round(watershed / area, 2)
        out[str(wb_id)] = dict(
            id=str(wb_id), name=str(_first(flat, ["name", "title", "name_ru"], wb_id)),
            type=str(_first(flat, ["type", "kind"], "lake")), lat=lat, lon=lon, bbox=bbox,
            area_km2=area,
            mean_depth_m=_num(_first(flat, ["mean_depth_m", "mean_depth", "depth_mean", "depth_m", "depth"])),
            max_depth_m=_num(_first(flat, ["max_depth_m", "max_depth", "depth_max"])),
            volume_mln_m3=_num(_first(flat, ["volume_mln_m3", "volume", "volume_mln"])),
            watershed_km2=watershed, watershed_ratio=ratio,
            protected_area=str(protected) if protected else None)
    return out


def load_geometry(path: Path) -> Dict[str, dict]:
    """Полигоны озёр из GeoJSON (lakes.geojson): идентификатор -> геометрия Polygon/MultiPolygon."""
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    kind = raw.get("type")
    feats = raw.get("features", []) if kind == "FeatureCollection" else [raw] if kind == "Feature" else []
    out: Dict[str, dict] = {}
    for f in feats:
        geom = f.get("geometry") or {}
        if geom.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        key = _first(f.get("properties") or {}, ["id", "water_body_id", "lake_id", "code"], f.get("id"))
        if key is not None:
            out[str(key)] = geom
    return out


CHL_COLUMNS = ["chl_a_est_current", "chl_a", "chl_a_current", "chl_a_mean", "chl_a_now", "chlorophyll_a", "chl"]
LAB_CHL_COLUMNS = ["chl_a_lab_ug_l", "chl_a_lab", "chl_a_measured", "chl_a_lab_current",
                   "chl_a_lab_mean", "lab_chl_a", "chl_a", "chl"]
DATE_COLUMNS = ["date", "sample_date", "obs_date", "date_used"]

MODE_SOURCE = {
    "satellite": "Sentinel-2 L2A (ESA/Copernicus)",
    "lab": "Лабораторная проба",
}


class RealDataProvider:
    """Читает витрину признаков (.parquet или .csv). Ключ строки: (water_body_id, date)."""

    def __init__(self, path: Path, registry: Dict[str, dict], chl_column: Optional[str] = None,
                 mode: str = "satellite"):
        path = Path(path)
        df = pd.read_parquet(path) if path.suffix == ".parquet" else pd.read_csv(path)
        self.mode = mode
        date_col = next((c for c in DATE_COLUMNS if c in df.columns), None)
        if "water_body_id" not in df.columns or date_col is None:
            raise IntegrationError(f"В {path.name} нет столбцов 'water_body_id' и/или {DATE_COLUMNS}. "
                                   f"Есть: {list(df.columns)}")
        if date_col != "date":
            df = df.rename(columns={date_col: "date"})
        df["date"] = pd.to_datetime(df["date"]).dt.date
        df = df.sort_values(["water_body_id", "date"]).reset_index(drop=True)
        self.by_wb = {str(k): g.reset_index(drop=True) for k, g in df.groupby("water_body_id")}
        unknown = set(self.by_wb) - set(registry)
        if unknown:
            raise IntegrationError(f"В витрине есть водоёмы, которых нет в реестре: {sorted(unknown)}")
        candidates = LAB_CHL_COLUMNS if mode == "lab" else CHL_COLUMNS
        self.chl_col = chl_column or next((c for c in candidates if c in df.columns), None)
        if self.chl_col is None:
            raise IntegrationError(f"Не нашёл столбец хлорофилла-a среди {candidates}. Есть: {list(df.columns)}. "
                                   f"Укажите его в переменной WATER_CHL_COLUMN.")
        self.columns = list(df.columns)
        self.path = path

    def supports(self, wb_id: str) -> bool:
        return wb_id in self.by_wb

    def available_dates(self, wb_id: str) -> List[date]:
        g = self.by_wb.get(wb_id)
        return [] if g is None else list(g["date"])

    def date_range(self, wb_id: str) -> Tuple[date, date]:
        ds = self.available_dates(wb_id)
        return ds[0], ds[-1]

    @staticmethod
    def _status(row) -> Optional[str]:
        status = row.get("obs_status")
        return None if status is None or pd.isna(status) else str(status)

    def _is_interpolated(self, row, status: Optional[str]) -> bool:
        interp = row.get("is_interpolated")
        return (status == "interpolated_1step") if interp is None or pd.isna(interp) else bool(interp)

    def _source(self, row) -> str:
        return MODE_SOURCE[self.mode]

    def row_meta(self, row) -> dict:
        status = self._status(row)
        return dict(
            date=row["date"], obs_status=status, is_interpolated=self._is_interpolated(row, status),
            chl_a_current=_num(row[self.chl_col]),
            temp_mean_14d=_num(row.get("temp_mean_14d")), calm_fraction_7d=_num(row.get("calm_fraction_7d")),
            scenes_in_decade=_int(row.get("scenes_in_decade")),
            valid_water_pixels=_int(row.get("valid_water_pixels")),
            scene_id=(None if row.get("scene_id") is None or pd.isna(row.get("scene_id")) else str(row.get("scene_id"))),
            source_note=(None if row.get("source_note") is None or pd.isna(row.get("source_note")) else str(row.get("source_note"))),
            source=self._source(row))

    def get_features(self, wb_id: str, d: date) -> Optional[dict]:
        g = self.by_wb.get(wb_id)
        if g is None:
            return None
        dates = list(g["date"])
        if d < dates[0] or d > dates[-1]:
            if min(abs((d - dates[0]).days), abs((d - dates[-1]).days)) > 10:
                return None
        i = min(range(len(dates)), key=lambda k: abs((dates[k] - d).days))
        row = g.iloc[i]
        meta = self.row_meta(row)
        meta.update(date_used=meta["date"],
                    _wb=wb_id, _doy=meta["date"].timetuple().tm_yday, _mode=self.mode,
                    _frame=g.iloc[[i]])
        return meta

    def history_frame(self, wb_id: str, end: date, limit: int = 120) -> pd.DataFrame:
        """Последние `limit` декад до `end` включительно (для графика и batch-прогноза)."""
        g = self.by_wb.get(wb_id)
        if g is None:
            return pd.DataFrame(columns=self.columns)
        part = g[g["date"] <= end].tail(limit).reset_index(drop=True)
        return part


# ------------------------------------------------------------------ Часть 2
def _feature_names(model) -> List[str]:
    for attr in ("feature_names_in_", "feature_name_"):
        v = getattr(model, attr, None)
        if v is not None:
            return list(v)
    booster = getattr(model, "booster_", None)
    if booster is not None:
        return list(booster.feature_name())
    raise IntegrationError(f"У модели {type(model).__name__} нет списка признаков (обучать нужно на DataFrame).")


class RealPredictor:
    """Модели Части 2 (sklearn-интерфейс). Опционально — отдельный классификатор внимания (>=15 мкг/л)."""

    def __init__(self, reg_path: Path, clf_path: Path, attention_path: Optional[Path] = None):
        self.reg, self.clf = joblib.load(reg_path), joblib.load(clf_path)
        self.attention = joblib.load(attention_path) if attention_path else None
        self.reg_cols, self.clf_cols = _feature_names(self.reg), _feature_names(self.clf)
        self.attention_cols = _feature_names(self.attention) if self.attention is not None else None
        self.names = (Path(reg_path).name, Path(clf_path).name)

    @staticmethod
    def _X(frame: pd.DataFrame, cols: List[str]) -> pd.DataFrame:
        missing = [c for c in cols if c not in frame.columns]
        if missing:
            raise IntegrationError(f"Модели нужны признаки, которых нет в витрине: {missing}")
        return frame[cols]

    @staticmethod
    def _positive_proba(model, X) -> float:
        proba = model.predict_proba(X)[0]
        classes = list(model.classes_)
        return float(proba[classes.index(1)]) if 1 in classes else float(proba[-1])

    def predict(self, f: dict) -> Tuple[float, float, Optional[float]]:
        frame = f["_frame"]
        chl = float(self.reg.predict(self._X(frame, self.reg_cols))[0])
        prob = self._positive_proba(self.clf, self._X(frame, self.clf_cols))
        att = (self._positive_proba(self.attention, self._X(frame, self.attention_cols))
               if self.attention is not None else None)
        return (round(max(chl, 0.0), 2), round(min(max(prob, 0.0), 1.0), 3),
                None if att is None else round(min(max(att, 0.0), 1.0), 3))

    def predict_many(self, frame: pd.DataFrame) -> List[Tuple[float, float, Optional[float]]]:
        """Векторный прогноз для истории: один вызов модели на весь ряд (быстро)."""
        if frame.empty:
            return []
        chl = self.reg.predict(self._X(frame, self.reg_cols))
        proba = self.clf.predict_proba(self._X(frame, self.clf_cols))
        classes = list(self.clf.classes_)
        idx = classes.index(1) if 1 in classes else -1
        att = None
        if self.attention is not None:
            pa = self.attention.predict_proba(self._X(frame, self.attention_cols))
            cls_a = list(self.attention.classes_)
            att = pa[:, cls_a.index(1) if 1 in cls_a else -1]
        return [(round(max(float(c), 0.0), 2), round(min(max(float(p), 0.0), 1.0), 3),
                 None if att is None else round(min(max(float(a), 0.0), 1.0), 3))
                for c, p, a in zip(chl, proba[:, idx], att if att is not None else [None] * len(chl))]


# ------------------------------------------------------------------ Часть 3
SYNONYMS = {
    "water_body_id": ["water_body_id", "wb_id", "lake_id", "water_body", "waterbody_id", "reservoir_id"],
    "water_body_name": ["water_body_name", "wb_name", "lake_name", "name"],
    "date": ["date", "forecast_date", "obs_date", "as_of", "timestamp"],
    "chl": ["chl_forecast", "chl_pred", "chl_a_pred", "chl_hat", "predicted_chl", "chl_a_forecast", "chl_a",
            "chl", "forecast_chl", "chla_pred", "c_hat", "chl_a_hat", "chl_a_pred_10d"],
    "prob": ["bloom_prob", "bloom_probability", "p_bloom", "prob", "probability", "p_hat", "bloom_proba",
             "pred_bloom_prob", "bloom_prob_pred", "p_bloom_pred"],
    "temp": ["temp_mean_14d", "t14", "temp_14d", "temperature_14d", "temp_mean_14"],
    "calm": ["calm_fraction_7d", "calm_frac_7d", "calm_fraction", "calm_share_7d", "calm_7d"],
}
ENGINE_METHODS = ("assess", "evaluate", "evaluate_alert", "classify", "predict_alert", "get_verdict", "run")


def _get(o, keys):
    for k in keys:
        v = o.get(k) if isinstance(o, dict) else getattr(o, k, None)
        if v is not None:
            return v
    return None


def _as_list(v) -> List[str]:
    if v is None:
        return []
    return [str(v)] if isinstance(v, str) else [str(x) for x in v]


def to_verdict(o) -> AlertVerdict:
    level = _get(o, ["alert_level", "level", "alert", "status"])
    level = str(getattr(level, "name", level)).upper().split(".")[-1]
    if level not in ("GREEN", "YELLOW", "RED"):
        raise IntegrationError(f"Уровень тревоги '{level}' не из GREEN/YELLOW/RED (объект: {o!r:.200})")
    tsi = _num(_get(o, ["trophic_index", "tsi", "carlson_index", "tsi_carson", "tsi_value"]))
    return AlertVerdict(
        alert_level=level, trophic_index=round(tsi, 1) if tsi is not None else 0.0,
        trophic_class=str(_get(o, ["trophic_class", "trophic_state", "trophic_level", "trophic_category"]) or "н/д"),
        reasons=_as_list(_get(o, ["reasons", "causes", "explanations", "reason"])),
        recommendations=_as_list(_get(o, ["recommendations", "measures", "actions", "advice"])))


class RealGraphEngine:
    """Обёртка над WaterKnowledgeGraphEngine из Части 3."""

    def __init__(self, module: str, ontology_path: Optional[Path] = None):
        mod = importlib.import_module(module)
        cls = getattr(mod, "WaterKnowledgeGraphEngine", None)
        if cls is None:
            raise IntegrationError(f"В модуле {module} нет класса WaterKnowledgeGraphEngine")
        try:
            self.engine = cls(str(ontology_path)) if ontology_path else cls()
        except TypeError:
            self.engine = cls()
        self.method = next((m for m in ENGINE_METHODS if callable(getattr(self.engine, m, None))), None)
        if self.method is None:
            pub = [m for m in dir(self.engine) if not m.startswith("_")]
            raise IntegrationError(f"Не нашёл метод оценки у движка. Публичные методы: {pub}")

    def describe(self) -> str:
        return f"{self.method}{inspect.signature(getattr(self.engine, self.method))}"

    def assess(self, wb_id, wb_name, d, chl, prob, temp14, calm7) -> AlertVerdict:
        fn = getattr(self.engine, self.method)
        values = dict(water_body_id=wb_id, water_body_name=wb_name, date=d, chl=chl, prob=prob,
                      temp=temp14, calm=calm7)
        kwargs = {}
        for pname, p in inspect.signature(fn).parameters.items():
            key = next((k for k, syn in SYNONYMS.items() if pname in syn), None)
            if key:
                kwargs[pname] = values[key]
            elif p.default is inspect.Parameter.empty and p.kind in (p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY):
                raise IntegrationError(f"Не знаю, что передать в параметр '{pname}': {self.describe()}")
        return to_verdict(fn(**kwargs))


def load_metrics(path: Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def load_quality(path: Optional[Path]) -> Optional[dict]:
    return json.loads(Path(path).read_text(encoding="utf-8")) if path else None
