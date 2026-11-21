# Контракт данных (Data Contract) — Часть 1 → Части 2, 3, 4

Этот файл фиксирует **согласованные форматы файлов и имена колонок**, которые Часть 1 (ETL & Feature Engineering) гарантирует на выходе для остальных участников команды.

## 1. Реестр водоёмов и геометрия (`configs/water_bodies.yaml` + `data/reference/lakes.geojson`)
- **Потребители:** Части 2, 3, 4.
- Содержит для каждого валидного озера:
  - `id` (строковый ключ, например `naroch`, `myastro`, `batorino`, `myadel`, `kuzmichi`, ...)
  - `name_ru`, `name_be`, `osm_type`, `osm_id`, `basin`
  - `center_lat`, `center_lon`, `bbox`
  - `morphometry`: `area_km2`, `mean_depth_m`, `max_depth_m`, `volume_mln_m3`, `watershed_km2`
  - `landcover` (при наличии OSM-слоёв водосбора): `forest_pct`, `farmland_pct`, `wetland_pct`, `settlement_pct`
  - точный полигон береговой линии в `data/reference/lakes.geojson` (для карты у Участника 4 и вырезки пикселей в Части 1).

## 2. Очищенные слои (`data/interim/`)
- `meteo_clean.parquet`: суточные метеоданные по каждому `water_body_id` и `date` (`T2M`, `T2M_MAX`, `T2M_MIN`, `WS2M`, `PRECTOTCORR`, `ALLSKY_SFC_SW_DWN`, `RH2M`).
- `satellite_scenes_raw.parquet`: попиксельная агрегация **каждого реального пролёта Sentinel-2** (`water_body_id`, `scene_id`, `scene_date`, `cloud_cover_scene`, `valid_water_pixels`, `total_roi_pixels`, `water_valid_ratio`, `b03_median`, `b04_median`, `b05_median`, `b08_median`, `ndci_median`, `ndti_median`, `chl_a_est_ug_l`, `tsi_est`).
- `satellite_decadal.parquet`: агрегация реальных сцен на регулярную 10-дневную сетку (`1, 11, 21` числа каждого месяца) с явным флагом статуса декады (`obs_status`: `valid`, `interpolated_1step`, `cloudy_missing`, `ice_cover`).
- `data_quality_report.json`: статистика полноты данных, числа валидных сцен, доли пропусков и отброшенных аномалий по каждому озеру.

## 3. Финальная витрина признаков (`data/processed/features_dataset.parquet` + `feature_metadata.json`)
- **Потребители:** Участник 2 (обучение ML), Участник 3 (контекстные метеопризнаки для БЗ), Участник 4 (выдача в API и графики).
- **Ключ строки:** уникальная пара `(water_body_id, date)` (декадный шаг 10 дней).
- **Группы колонок:**
  1. **Служебные (`meta_cols`):** `water_body_id`, `water_body_name`, `date`, `obs_status`, `valid_water_pixels`, `scenes_in_decade`, `is_interpolated`.
  2. **Признаки (`feature_cols`):**
     - *Сезонность:* `month`, `day_of_year`, `sin_doy`, `cos_doy`
     - *Морфометрия и водосбор:* `area_km2`, `mean_depth_m`, `max_depth_m`, `watershed_ratio` (плюс ландшафтные при наличии)
     - *Текущее оптическое состояние и динамика:* `ndci_current`, `ndci_lag10d`, `ndci_growth_10d`, `ndti_current`, `chl_a_est_current`, `chl_a_est_lag10d`, `tsi_current`
     - *Погодные окна (строго до `date` включительно, без утечки будущего):* `temp_mean_7d`, `temp_max_7d`, `temp_mean_14d`, `temp_mean_21d`, `hot_days_14d`, `precip_sum_7d`, `precip_sum_14d`, `radiation_mean_7d`, `wind_mean_7d`, `calm_fraction_7d`
  3. **Целевые переменные (`target_cols`, сдвиг ровно на `+10 дней`):**
     - `target_ndci_next_10d` — реальный спутниковый индекс `NDCI` на следующей декаде
     - `target_chl_a_est_next_10d` — оценка хлорофилла-a (мкг/л) на следующей декаде
     - `target_bloom_risk_next_10d` — бинарный флаг риска цветения (`1`, если `target_chl_a_est_next_10d >= 25.0` мкг/л, иначе `0`)
