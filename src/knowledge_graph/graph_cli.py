"""Записывает водоёмы, прогнозы и наблюдения в локальный Turtle-файл."""

import argparse
from calendar import monthrange
from datetime import date
import json
from math import isfinite
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.parse import quote

from filelock import FileLock, Timeout
from rdflib import Graph, Namespace
from rdflib.exceptions import ParserError
from rdflib.plugins.serializers.turtle import TurtleSerializer


BASE_IRI = "https://shinigam2.github.io/eutrophication/"
DATA_DIR = Path(__file__).resolve().parents[2] / "data"
DEFAULT_GRAPH = DATA_DIR / "knowledge_graph" / "graph.ttl"
DEFAULT_GEOJSON = DATA_DIR / "reference" / "lakes.geojson"
PREFIXES = f"""
PREFIX eutro: <{BASE_IRI}>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
"""

ALERT_RULE_ID = "chlorophyll-alert"
SEED_RULE = f"INSERT DATA {{ eutro:{ALERT_RULE_ID} eutro:thresholdUgL 25 . }}"

CREATE_ALERTS = """
INSERT {
  ?alert a eutro:Alert ; eutro:forForecast ?forecast ; eutro:triggeredRule ?rule .
}
WHERE {
  ?forecast a eutro:Forecast ; eutro:chlorophyllUgL ?predicted ; eutro:usesRule ?rule .
  ?rule eutro:thresholdUgL ?threshold .
  FILTER (?predicted >= ?threshold)
  BIND(IRI(CONCAT(STR(?forecast), "/alert")) AS ?alert)
}
"""

HISTORY = """
SELECT ?waterBodyId ?waterBody ?periodStart ?periodEnd ?predictedUgL ?thresholdUgL
       ?alertStatus ?observedUgL ?obsStatus
WHERE {
  {
    SELECT DISTINCT ?water ?periodStart ?periodEnd
    WHERE {
      VALUES ?kind { eutro:Forecast eutro:Observation }
      ?entry a ?kind ; eutro:waterBody ?water ; eutro:period ?period .
      ?period eutro:start ?periodStart ; eutro:end ?periodEnd .
    }
  }
  OPTIONAL { ?water eutro:waterBodyId ?registeredId . }
  OPTIONAL { ?water eutro:name ?name . }
  BIND(COALESCE(?registeredId, STRAFTER(STR(?water), STR(eutro:))) AS ?waterBodyId)
  BIND(COALESCE(?name, ?waterBodyId) AS ?waterBody)
  OPTIONAL {
    ?forecast a eutro:Forecast ; eutro:waterBody ?water ; eutro:period ?forecastPeriod ;
        eutro:chlorophyllUgL ?predictedUgL ; eutro:usesRule ?rule .
    ?forecastPeriod eutro:start ?periodStart .
    ?rule eutro:thresholdUgL ?thresholdUgL .
    OPTIONAL { ?alert a eutro:Alert ; eutro:forForecast ?forecast . }
    BIND(IF(BOUND(?alert), "warning", "below_threshold") AS ?alertStatus)
  }
  OPTIONAL {
    ?observation a eutro:Observation ; eutro:waterBody ?water ; eutro:period ?observationPeriod ;
        eutro:chlorophyllUgL ?observedUgL .
    ?observationPeriod eutro:start ?periodStart .
    OPTIONAL { ?observation eutro:obsStatus ?obsStatus . }
  }
}
ORDER BY ?periodStart ?waterBody
"""


def parse_period_start(value):
    try:
        start = date.fromisoformat(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("укажи дату в формате YYYY-MM-DD") from error
    if start.day not in (1, 11, 21):
        raise argparse.ArgumentTypeError("начало декады — 1, 11 или 21 число")
    return start


def parse_concentration(value):
    try:
        concentration = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("укажи число в мкг/л") from error
    if not isfinite(concentration) or concentration < 0:
        raise argparse.ArgumentTypeError("концентрация должна быть конечной и неотрицательной")
    return concentration


def water_binding(water_segment, id_literal):
    water = f"<{BASE_IRI}water/{water_segment}>"
    return f"""
  OPTIONAL {{ ?registeredWater eutro:waterBodyId {id_literal} . }}
  BIND(COALESCE(?registeredWater, {water}) AS ?water)
"""


def lake_import_operations(geojson_path):
    source = json.loads(geojson_path.read_text(encoding="utf-8"))
    if (not isinstance(source, dict) or source.get("type") != "FeatureCollection"
            or not isinstance(source.get("features"), list)):
        raise ValueError("ожидается GeoJSON FeatureCollection")

    operations = []
    seen = set()
    for index, feature in enumerate(source["features"], start=1):
        properties = feature.get("properties") if isinstance(feature, dict) else None
        if not isinstance(properties, dict):
            raise ValueError(f"объект №{index} должен содержать properties")
        water_id, name = properties.get("id"), properties.get("name_ru")
        if not isinstance(water_id, str) or not water_id.strip():
            raise ValueError(f"объект №{index} должен содержать properties.id")
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"водоём {water_id!r} должен содержать properties.name_ru")
        if water_id in seen:
            raise ValueError(f"повторяющийся ID водоёма {water_id!r}")
        seen.add(water_id)

        water_segment = quote(water_id, safe="")
        id_literal = json.dumps(water_id, ensure_ascii=False)
        name_literal = json.dumps(name, ensure_ascii=False)
        operations.append(f"""
DELETE {{ ?water eutro:name ?currentName . }}
INSERT {{
  ?water a eutro:WaterBody ; eutro:waterBodyId {id_literal} ; eutro:name {name_literal} .
}}
WHERE {{
  {water_binding(water_segment, id_literal)}
  OPTIONAL {{ ?water eutro:name ?currentName . }}
}}
""")
    return operations


def insert_record(phase, water_body_id, period_start, value, name):
    water_segment = quote(water_body_id, safe="")
    last_day = monthrange(period_start.year, period_start.month)[1]
    period_end = period_start.replace(day=last_day if period_start.day == 21 else period_start.day + 9)
    period = f"<{BASE_IRI}period/{period_start}>"
    record_type, detail = {
        "forecast": ("Forecast", f"eutro:usesRule eutro:{ALERT_RULE_ID}"),
        "observe": ("Observation", 'eutro:obsStatus "valid"'),
    }[phase]
    record = f"<{BASE_IRI}{record_type.lower()}/{water_segment}/{period_start}>"
    id_literal = json.dumps(water_body_id, ensure_ascii=False)

    # Keep previously issued records and avoid duplicates when the job is retried.
    operation = f"""
INSERT {{
  ?water a eutro:WaterBody ; eutro:waterBodyId {id_literal} .
  {period} eutro:start "{period_start}"^^xsd:date ; eutro:end "{period_end}"^^xsd:date .
  {record} a eutro:{record_type} ; eutro:waterBody ?water ; eutro:period {period} ;
      eutro:chlorophyllUgL {value} ; {detail} .
}}
WHERE {{
  {water_binding(water_segment, id_literal)}
  OPTIONAL {{
    ?existing a eutro:{record_type} ; eutro:waterBody ?water ; eutro:period ?existingPeriod .
    ?existingPeriod eutro:start "{period_start}"^^xsd:date .
  }}
  FILTER(!BOUND(?existing))
}}
"""
    if name:
        name_literal = json.dumps(name, ensure_ascii=False)
        operation += f""";
INSERT {{ ?water eutro:name {name_literal} . }}
WHERE {{
  ?water eutro:waterBodyId {id_literal} .
  OPTIONAL {{ ?water eutro:name ?existingName . }}
  FILTER(!BOUND(?existingName))
}}
"""
    return operation


def load_graph(graph_path):
    graph = Graph()
    if graph_path.exists():
        graph.parse(graph_path, format="turtle")
    graph.bind("eutro", Namespace(BASE_IRI), replace=True)
    graph.bind("water", Namespace(BASE_IRI + "water/"), replace=True)
    graph.bind("period", Namespace(BASE_IRI + "period/"), replace=True)
    return graph


def update_file(graph_path, *operations):
    graph_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = graph_path.with_name(f".{graph_path.name}.lock")
    with FileLock(lock_path, timeout=10):
        graph = load_graph(graph_path)
        for operation in operations:
            graph.update(PREFIXES + operation)

        temporary = NamedTemporaryFile(dir=graph_path.parent, suffix=".ttl", delete=False)
        temporary_path = Path(temporary.name)
        try:
            with temporary:
                serializer = TurtleSerializer(graph)
                serializer.roundtrip_prefixes = ("period",)
                serializer.serialize(temporary)
            temporary_path.replace(graph_path)
        finally:
            temporary_path.unlink(missing_ok=True)
    return graph


def show_history(graph, water_body_id):
    result = graph.query(PREFIXES + HISTORY)
    columns = [str(var) for var in result.vars]
    rows = []
    for binding in result:
        row = {column: str(value) if value is not None else None
               for column, value in zip(columns, binding)}
        if water_body_id is not None and row["waterBodyId"] != water_body_id:
            continue
        for column in ("predictedUgL", "thresholdUgL", "observedUgL"):
            if row[column] is not None:
                row[column] = float(row[column])
        rows.append(row)
    print(json.dumps(rows, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("sync-lakes", "forecast", "observe", "history"))
    parser.add_argument("--graph", type=Path, default=DEFAULT_GRAPH, help="путь к Turtle-файлу")
    parser.add_argument("--geojson", type=Path, help="файл контуров для команды sync-lakes")
    parser.add_argument("--water-body-id", help="ID из реестра водоёмов")
    parser.add_argument("--name", help="название водоёма при первой записи")
    parser.add_argument("--period-start", type=parse_period_start, help="начало целевой декады")
    parser.add_argument("--value", type=parse_concentration, help="концентрация хлорофилла-а в мкг/л")
    args = parser.parse_args()

    record_fields = (args.name, args.period_start, args.value)
    graph_path = args.graph.expanduser().resolve()
    if args.phase == "sync-lakes":
        if args.water_body_id is not None or any(field is not None for field in record_fields):
            parser.error("sync-lakes принимает только --geojson и --graph")
        geojson_path = (args.geojson or DEFAULT_GEOJSON).expanduser().resolve()
        try:
            operations = lake_import_operations(geojson_path)
            if operations:
                update_file(graph_path, *operations)
        except (OSError, ValueError, SyntaxError, ParserError, Timeout) as error:
            parser.exit(1, f"Ошибка импорта озёр из {geojson_path}\n{error}\n")
        print(f"Озёр синхронизировано: {len(operations)}")
        return

    if args.geojson is not None:
        parser.error("--geojson доступен только для sync-lakes")
    if args.phase == "history":
        if any(field is not None for field in record_fields):
            parser.error("history принимает только --water-body-id и --graph")
    else:
        if not args.water_body_id or args.period_start is None or args.value is None:
            parser.error("укажи --water-body-id, --period-start и --value")
        operation = insert_record(args.phase, args.water_body_id, args.period_start, args.value, args.name)

    try:
        if args.phase == "forecast":
            graph = update_file(graph_path, SEED_RULE, operation, CREATE_ALERTS)
        elif args.phase == "observe":
            graph = update_file(graph_path, operation)
        else:
            graph = load_graph(graph_path)
        show_history(graph, args.water_body_id)
    except (OSError, SyntaxError, ParserError, Timeout) as error:
        parser.exit(1, f"Ошибка при работе с {graph_path}\n{error}\n")


if __name__ == "__main__":
    main()
