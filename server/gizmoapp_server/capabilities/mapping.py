from __future__ import annotations

import heapq
import json
import math
import os
import threading
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from typing import Any


DEFAULT_LOCATION = {
    "label": "UBC Vancouver",
    "latitude": 49.26835,
    "longitude": -123.25214,
    "zoom": 15,
    "source": "default",
}

LANDMARKS = {
    "start": {
        "label": "Gage Apartments",
        "latitude": 49.2701657,
        "longitude": -123.2492019,
        "source": "OpenStreetMap, way 36827456",
    },
    "end": {
        "label": "Koerner Library",
        "latitude": 49.2665489,
        "longitude": -123.2550780,
        "source": "OpenStreetMap, way 27318161",
    },
}

LOCATIONS = [
    LANDMARKS["start"],
    LANDMARKS["end"],
    {"label": "UBC Bus Loop", "latitude": 49.26863, "longitude": -123.24604},
    {"label": "AMS Nest", "latitude": 49.26691, "longitude": -123.24953},
    {"label": "Main Mall", "latitude": 49.26688, "longitude": -123.25364},
    {"label": "Student Recreation Centre", "latitude": 49.26604, "longitude": -123.24791},
    {"label": "Rose Garden", "latitude": 49.26930, "longitude": -123.25606},
    {"label": "Museum of Anthropology", "latitude": 49.26979, "longitude": -123.25849},
    {"label": "UBC Life Building", "latitude": 49.26691, "longitude": -123.25090},
    {"label": "Buchanan Building", "latitude": 49.26654, "longitude": -123.25416},
    {"label": "Earth Sciences Building", "latitude": 49.26636, "longitude": -123.25575},
    {"label": "Nest Beach", "latitude": 49.26819, "longitude": -123.25262},
    {"label": "Nitobe Memorial Garden", "latitude": 49.27123, "longitude": -123.25730},
    {"label": "Thunderbird Park", "latitude": 49.26483, "longitude": -123.24488},
    {"label": "UBC Hospital", "latitude": 49.26464, "longitude": -123.24687},
]

OVERPASS_URLS = ("https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter")
UBC_GRAPH_BOUNDS = (49.262, -123.264, 49.275, -123.240)
WALKABLE_HIGHWAYS = {"footway", "path", "pedestrian", "living_street", "residential", "service", "unclassified", "tertiary", "secondary", "primary"}
_GRAPH_CACHE: dict[str, Any] | None = None
_GRAPH_LOCK = threading.Lock()


def _graph_cache_path() -> Path:
    configured = Path(os.environ.get("GIZMO_OSM_GRAPH_CACHE", "var/ubc-walking-graph.json")).expanduser()
    if configured.is_absolute():
        return configured
    # The server may be started from a different working directory in the hosted preview.
    return Path(__file__).resolve().parents[3] / configured


def _load_graph_cache() -> dict[str, Any] | None:
    global _GRAPH_CACHE
    if _GRAPH_CACHE is not None:
        return _GRAPH_CACHE
    for path in (_graph_cache_path(), _graph_cache_path().with_suffix(".bak")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            nodes = {int(key): tuple(value) for key, value in payload["nodes"].items()}
            edges = {int(key): [(int(neighbor), float(length), highway) for neighbor, length, highway in values] for key, values in payload["edges"].items()}
            if nodes and edges:
                _GRAPH_CACHE = {"nodes": nodes, "edges": edges}
                return _GRAPH_CACHE
        except (OSError, ValueError, TypeError, KeyError):
            continue
    return _GRAPH_CACHE


def _save_graph_cache(nodes: dict[int, tuple[float, float]], edges: dict[int, list[tuple[int, float, str]]]) -> None:
    path = _graph_cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"version": 1, "bounds": UBC_GRAPH_BOUNDS, "nodes": nodes, "edges": edges}, separators=(",", ":")), encoding="utf-8")
    if path.exists():
        backup = path.with_suffix(".bak")
        try:
            path.replace(backup)
        except OSError:
            pass
    temporary.replace(path)


def _distance(first: tuple[float, float], second: tuple[float, float]) -> float:
    lat_scale = 111_000
    lon_scale = lat_scale * math.cos(math.radians((first[1] + second[1]) / 2))
    return math.hypot((first[1] - second[1]) * lat_scale, (first[0] - second[0]) * lon_scale)


def _project_to_segment(point: tuple[float, float], first: tuple[float, float], second: tuple[float, float]) -> tuple[tuple[float, float], float]:
    latitude_scale = 111_000
    longitude_scale = latitude_scale * math.cos(math.radians(point[1]))
    px, py = point[0] * longitude_scale, point[1] * latitude_scale
    ax, ay = first[0] * longitude_scale, first[1] * latitude_scale
    bx, by = second[0] * longitude_scale, second[1] * latitude_scale
    dx, dy = bx - ax, by - ay
    fraction = 0.0 if dx * dx + dy * dy == 0 else ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    fraction = min(1.0, max(0.0, fraction))
    return ((first[0] + (second[0] - first[0]) * fraction, first[1] + (second[1] - first[1]) * fraction), fraction)


def _overpass_graph(bounds: tuple[float, float, float, float]) -> tuple[dict[int, tuple[float, float]], dict[int, list[tuple[int, float, str]]]]:
    global _GRAPH_CACHE
    del bounds
    with _GRAPH_LOCK:
        cached = _load_graph_cache()
        if cached:
            return cached["nodes"], cached["edges"]
        south, west, north, east = UBC_GRAPH_BOUNDS
        query = f"[out:json][timeout:20];way[highway]({south},{west},{north},{east});out tags geom;"
        elements = None
        last_error: Exception | None = None
        for endpoint in OVERPASS_URLS:
            for attempt in range(3):
                try:
                    request = Request(f"{endpoint}?{urlencode({'data': query})}", headers={"User-Agent": "GizmoApp UBC walking route"})
                    with urlopen(request, timeout=25) as response:
                        elements = json.load(response).get("elements", [])
                    break
                except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
                    last_error = exc
                    retryable = not isinstance(exc, HTTPError) or exc.code == 429 or exc.code >= 500
                    if not retryable or attempt == 2:
                        break
                    time.sleep(0.5 * (2 ** attempt))
            if elements is not None:
                break
        if elements is None:
            raise RuntimeError("Overpass unavailable") from last_error
        nodes: dict[int, tuple[float, float]] = {}
        edges: dict[int, list[tuple[int, float, str]]] = {}
        for way in elements:
            highway = way.get("tags", {}).get("highway")
            geometry = way.get("geometry", [])
            if highway not in WALKABLE_HIGHWAYS or len(geometry) < 2:
                continue
            previous = None
            for point in geometry:
                node_id = point.get("lat"), point.get("lon")
                if None in node_id:
                    continue
                key = hash((round(node_id[0], 7), round(node_id[1], 7)))
                nodes[key] = (node_id[1], node_id[0])
                edges.setdefault(key, [])
                if previous is not None:
                    length = _distance(nodes[previous], nodes[key])
                    edges[previous].append((key, length, highway))
                    edges[key].append((previous, length, highway))
                previous = key
        if not nodes:
            raise ValueError("OpenStreetMap returned no walkable ways in this area")
        _save_graph_cache(nodes, edges)
        _GRAPH_CACHE = {"nodes": nodes, "edges": edges}
        return nodes, edges


def osm_walking_route(start: dict[str, Any], end: dict[str, Any], mode: str = "calm") -> dict[str, Any]:
    margin = 0.004
    bounds = (round(min(start["latitude"], end["latitude"]) - margin, 4), round(min(start["longitude"], end["longitude"]) - margin, 4), round(max(start["latitude"], end["latitude"]) + margin, 4), round(max(start["longitude"], end["longitude"]) + margin, 4))
    nodes, edges = _overpass_graph(bounds)
    if not nodes:
        raise ValueError("OpenStreetMap returned no walkable ways in this area")

    route_edges = {key: list(value) for key, value in edges.items()}
    route_nodes = dict(nodes)

    def attach_point(point: dict[str, Any], node_id: int) -> None:
        location = (point["longitude"], point["latitude"])
        best = None
        for first, neighbors in edges.items():
            for second, length, highway in neighbors:
                if first > second:
                    continue
                projection, fraction = _project_to_segment(location, nodes[first], nodes[second])
                candidate = _distance(location, projection)
                if best is None or candidate < best[0]:
                    best = (candidate, first, second, length, highway, projection, fraction)
        if best is None:
            raise ValueError("OpenStreetMap returned no usable walking segments")
        _, first, second, length, highway, projection, fraction = best
        route_nodes[node_id] = projection
        route_edges[node_id] = [(first, length * fraction, highway), (second, length * (1 - fraction), highway)]
        route_edges[first] = [(neighbor, edge_length, edge_highway) for neighbor, edge_length, edge_highway in route_edges[first] if neighbor != second]
        route_edges[second] = [(neighbor, edge_length, edge_highway) for neighbor, edge_length, edge_highway in route_edges[second] if neighbor != first]
        route_edges[first].append((node_id, length * fraction, highway))
        route_edges[second].append((node_id, length * (1 - fraction), highway))

    source, target = -1, -2
    attach_point(start, source)
    attach_point(end, target)
    distances = {source: 0.0}
    previous: dict[int, int] = {}
    pending = [(0.0, source)]
    while pending:
        current_distance, current = heapq.heappop(pending)
        if current != source and current_distance != distances.get(current):
            continue
        if current == target:
            break
        for neighbor, length, highway in route_edges[current]:
            penalty = 1.0
            if mode == "calm" and highway in {"primary", "secondary", "tertiary", "residential"}:
                penalty = 1.18
            elif mode == "scenic" and highway not in {"path", "footway", "pedestrian"}:
                penalty = 1.25
            elif mode == "crowds" and highway in {"primary", "secondary", "tertiary", "pedestrian"}:
                penalty = 1.35
            candidate = current_distance + length * penalty
            if candidate < distances.get(neighbor, float("inf")):
                distances[neighbor] = candidate
                previous[neighbor] = current
                heapq.heappush(pending, (candidate, neighbor))
    if target not in distances:
        raise ValueError("OpenStreetMap could not connect those walking points")
    keys = []
    current = target
    while True:
        keys.append(current)
        if current == source:
            break
        current = previous[current]
    coordinates = [list(route_nodes[key]) for key in reversed(keys)]
    distance = round(sum(_distance((coordinates[index][0], coordinates[index][1]), (coordinates[index + 1][0], coordinates[index + 1][1])) for index in range(len(coordinates) - 1)))
    return {
        "coordinates": coordinates,
        "distance": distance,
        "minutes": max(1, round(distance / 80)),
        "mode": mode,
        "source": "OpenStreetMap footways via Overpass",
    }


def osm_walking_graph(start: dict[str, Any], end: dict[str, Any]) -> dict[str, Any]:
    """Return the cached OSM walking graph so the browser can route locally."""
    margin = 0.004
    bounds = (round(min(start["latitude"], end["latitude"]) - margin, 4), round(min(start["longitude"], end["longitude"]) - margin, 4), round(max(start["latitude"], end["latitude"]) + margin, 4), round(max(start["longitude"], end["longitude"]) + margin, 4))
    nodes, edges = _overpass_graph(bounds)
    serialized_edges = []
    seen: set[tuple[int, int]] = set()
    for first, neighbors in edges.items():
        for second, length, highway in neighbors:
            edge_key = (min(first, second), max(first, second))
            if edge_key in seen:
                continue
            seen.add(edge_key)
            serialized_edges.append([str(first), str(second), length, highway])
    return {
        "nodes": {str(key): [value[0], value[1]] for key, value in nodes.items()},
        "edges": serialized_edges,
        "source": "OpenStreetMap footways via Overpass",
    }


def openstreetmap_config() -> dict[str, Any]:
    return {
        "provider": "openstreetmap",
        "tileUrlTemplate": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        "attribution": "Map data from OpenStreetMap contributors.",
        "defaultLocation": DEFAULT_LOCATION,
        "landmarks": LANDMARKS,
        "locations": LOCATIONS,
    }
