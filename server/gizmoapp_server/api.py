from __future__ import annotations

import json
import math
import re
import secrets
import sqlite3
from datetime import UTC, datetime
from typing import Any

from flask import Flask, current_app, g, jsonify, request
from werkzeug.exceptions import BadRequest, HTTPException, RequestEntityTooLarge, UnsupportedMediaType

from .capabilities import capability_payload
from .capabilities.audio import analyze_samples
from .capabilities.mapping import osm_walking_graph, osm_walking_route, openstreetmap_config
from .capabilities.ml import run_kmeans, sklearn_status
from .capabilities.optimization import nearest_neighbor_route
from .capabilities.search import search_records
from .config import scoped_path
from .db import database_readiness, fetch_sample_nodes, get_db, insert_sample_node
from .llm import CourseLLMError, ask

HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
SLUG_RE = re.compile(r"^[a-z0-9-]{3,40}$")
MAX_LABEL_LENGTH = 120
MAX_DESCRIPTION_LENGTH = 2_000
MAX_SEARCH_QUERY_LENGTH = 200
MAX_ROUTE_PROMPT_LENGTH = 500
MAX_LOCATION_LENGTH = 120


def _health_payload() -> dict[str, Any]:
    return {
        "status": "ok",
        "serverTime": datetime.now(UTC).isoformat(),
    }


def _bootstrap_payload() -> dict[str, Any]:
    return {
        "app": {
            "name": current_app.config["APP_NAME"],
            "tagline": current_app.config["APP_TAGLINE"],
            "mode": "public",
            "shell": current_app.config["APP_SHELL"],
            "shellLabel": current_app.config["APP_SHELL_LABEL"],
        },
        "health": _health_payload(),
        "availableShells": current_app.config["AVAILABLE_SHELLS"],
    }


def _api_root() -> str:
    return scoped_path(current_app.config["URL_PREFIX"], "api").rstrip("/")


def _is_json_surface() -> bool:
    api_root = _api_root()
    return (
        request.path == api_root
        or request.path.startswith(f"{api_root}/")
        or request.path.endswith("/healthz")
        or request.path.endswith("/readyz")
        or request.path in {"/healthz", "/readyz"}
    )


def _error_response(message: str, status: int):
    return jsonify({"errors": [message], "requestId": getattr(g, "request_id", None)}), status


def _route_mode(value: Any) -> str:
    return value if value in {"fastest", "calm", "crowds", "accessible", "scenic"} else "calm"


def _route_result(mode: str, interpretation: str, weights: dict[str, Any] | None = None) -> dict[str, Any]:
    routes = {
        "calm": ("The Shaded Stroll", "A quieter path through Main Mall, prioritizing tree cover and open air over the fastest crossing.", 92, 18, "1.2", "Low", "quiet paths + green space", "maximize tree cover"),
        "crowds": ("The Quiet Cut-through", "A low-traffic route that skirts the busiest crossings, with a few extra minutes for more breathing room.", 89, 21, "1.4", "Very low", "minimize pedestrian traffic", "prefer calm crossings"),
        "accessible": ("The Easy-Grade Route", "A step-free route using accessible entrances and gentler gradients. Elevator access is noted along the way.", 96, 20, "1.3", "Medium", "avoid stairs + steep grades", "prioritize curb cuts"),
        "scenic": ("The Greenway Loop", "A longer route threaded through gardens and open green space, with the best views of campus along the way.", 87, 24, "1.7", "Low", "maximize green space", "prefer open-air paths"),
    }
    title, description, score, minutes, distance, traffic, signal_one, signal_two = routes[mode]
    defaults = {
        "calm": {"time": 25, "comfort": 45, "access": 10, "scenery": 20},
        "crowds": {"time": 20, "comfort": 55, "access": 10, "scenery": 15},
        "accessible": {"time": 20, "comfort": 20, "access": 50, "scenery": 10},
        "scenic": {"time": 15, "comfort": 25, "access": 10, "scenery": 50},
    }
    clean_weights = defaults[mode].copy()
    if isinstance(weights, dict):
        for key in clean_weights:
            try:
                clean_weights[key] = min(100, max(0, int(weights.get(key, clean_weights[key]))))
            except (TypeError, ValueError):
                pass
    return {
        "mode": mode,
        "title": title,
        "description": description,
        "score": score,
        "minutes": minutes,
        "distance": distance,
        "traffic": traffic,
        "interpretationLabel": interpretation,
        "signalOne": signal_one,
        "signalTwo": signal_two,
        "weights": clean_weights,
    }


def _json_object() -> tuple[dict[str, Any] | None, tuple[Any, int] | None]:
    if not request.is_json:
        return None, _error_response("Content-Type must be application/json", 415)
    try:
        payload = request.get_json(silent=False)
    except (BadRequest, UnsupportedMediaType):
        return None, _error_response("Request body must contain valid JSON", 400)
    if not isinstance(payload, dict):
        return None, _error_response("JSON request body must be an object", 400)
    return payload, None


def _finite_number(payload: dict[str, Any], key: str, default: float) -> float:
    value = float(payload.get(key, default))
    if not math.isfinite(value):
        raise ValueError(f"{key} must be finite")
    return value


def _normalize_payload(payload: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []
    raw_slug = payload.get("slug", "")
    raw_label = payload.get("label", "")
    raw_description = payload.get("description", "")
    raw_color = payload.get("accent_color", "#72d1c2")

    for name, value in (
        ("slug", raw_slug),
        ("label", raw_label),
        ("description", raw_description),
        ("accent_color", raw_color),
    ):
        if not isinstance(value, str):
            errors.append(f"{name} must be a string")

    cleaned = {
        "slug": raw_slug.strip() if isinstance(raw_slug, str) else "",
        "label": raw_label.strip() if isinstance(raw_label, str) else "",
        "description": raw_description.strip() if isinstance(raw_description, str) else "",
        "accent_color": raw_color.strip() if isinstance(raw_color, str) else "",
    }
    cleaned["description"] = cleaned["description"] or "Created through the sample API."

    if not SLUG_RE.fullmatch(cleaned["slug"]):
        errors.append("slug must be 3-40 characters of lowercase letters, digits, or hyphens")
    if len(cleaned["label"]) < 2 or len(cleaned["label"]) > MAX_LABEL_LENGTH:
        errors.append(f"label must be 2-{MAX_LABEL_LENGTH} characters")
    if len(cleaned["description"]) > MAX_DESCRIPTION_LENGTH:
        errors.append(f"description must be at most {MAX_DESCRIPTION_LENGTH} characters")
    if not HEX_COLOR_RE.fullmatch(cleaned["accent_color"]):
        errors.append("accent_color must be a 6-digit hex color like #72d1c2")

    try:
        cleaned["x"] = min(0.92, max(0.08, _finite_number(payload, "x", 0.5)))
        cleaned["y"] = min(0.92, max(0.08, _finite_number(payload, "y", 0.5)))
        cleaned["radius"] = min(0.2, max(0.06, _finite_number(payload, "radius", 0.11)))
    except (TypeError, ValueError, OverflowError):
        errors.append("x, y, and radius must be finite numbers")

    return cleaned, errors


def register_api_routes(app: Flask) -> None:
    prefix = app.config["URL_PREFIX"]
    enabled_features = frozenset(app.config["ENABLED_FEATURES"])

    @app.before_request
    def assign_request_id():
        g.request_id = secrets.token_hex(8)

    @app.after_request
    def harden_response(response):
        response.headers.setdefault("X-Request-ID", getattr(g, "request_id", ""))
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault("Cross-Origin-Resource-Policy", "same-origin")
        return response

    @app.errorhandler(RequestEntityTooLarge)
    def request_too_large(_: RequestEntityTooLarge):
        if _is_json_surface():
            return _error_response("Request body is too large", 413)
        return "Request body is too large", 413

    @app.errorhandler(HTTPException)
    def http_error(error: HTTPException):
        if _is_json_surface():
            return _error_response(error.description or error.name, error.code or 500)
        return error

    @app.errorhandler(Exception)
    def unexpected_error(error: Exception):
        current_app.logger.exception("Unhandled request error")
        if _is_json_surface():
            return _error_response("The server could not complete the request", 500)
        return "The server could not complete the request", 500

    @app.get(scoped_path(prefix, "healthz"))
    def healthz():
        return jsonify(_health_payload())

    @app.get(scoped_path(prefix, "readyz"))
    def readyz():
        ready, detail = database_readiness(current_app.config)
        return jsonify({"status": "ready" if ready else "not-ready", **detail}), 200 if ready else 503

    @app.get(scoped_path(prefix, "api/bootstrap"))
    def bootstrap():
        return jsonify(_bootstrap_payload())

    @app.get(scoped_path(prefix, "api/capabilities"))
    def capabilities():
        api_base = scoped_path(prefix, "api").rstrip("/")
        return jsonify(capability_payload(api_base, enabled_features))

    @app.post(scoped_path(prefix, "api/interpret-route"))
    def interpret_route():
        payload, error = _json_object()
        if error:
            return error
        prompt = payload.get("prompt", "")
        start = payload.get("from", "")
        destination = payload.get("to", "")
        condition = payload.get("condition", "sunny")
        if not all(isinstance(value, str) for value in (prompt, start, destination, condition)):
            return _error_response("Route fields must be text", 400)
        prompt, start, destination = prompt.strip(), start.strip(), destination.strip()
        if not prompt or len(prompt) > MAX_ROUTE_PROMPT_LENGTH:
            return _error_response(f"prompt must be 1-{MAX_ROUTE_PROMPT_LENGTH} characters", 400)
        if not start or len(start) > MAX_LOCATION_LENGTH or not destination or len(destination) > MAX_LOCATION_LENGTH:
            return _error_response(f"locations must be 1-{MAX_LOCATION_LENGTH} characters", 400)
        if condition not in {"sunny", "rain", "after-dark"}:
            return _error_response("condition is not supported", 400)

        try:
            raw = ask(
                """You interpret a campus walking preference for a route planner. Return JSON only, with no markdown.
Use exactly one mode: calm, crowds, accessible, or scenic. Keep interpretation to 5 words or fewer.
Return preference weights as whole-number percentages from 0 to 100. They do not need to add to 100.
Schema: {\"mode\": \"calm|crowds|accessible|scenic\", \"interpretation\": \"short phrase\", \"weights\": {\"time\": 0, \"comfort\": 0, \"access\": 0, \"scenery\": 0}}
User request: """ + json.dumps({"from": start, "to": destination, "preference": prompt, "condition": condition}),
                max_tokens=120,
            )
            cleaned = raw.strip().removeprefix("```json").removesuffix("```").strip()
            model_result = json.loads(cleaned)
            mode = _route_mode(model_result.get("mode")) if isinstance(model_result, dict) else "calm"
            interpretation = model_result.get("interpretation", prompt) if isinstance(model_result, dict) else prompt
            if not isinstance(interpretation, str) or not interpretation.strip():
                interpretation = prompt
            return jsonify(_route_result(mode, interpretation[:80], model_result.get("weights") if isinstance(model_result, dict) else None))
        except (CourseLLMError, json.JSONDecodeError, TypeError, AttributeError) as exc:
            return _error_response(str(exc) if isinstance(exc, CourseLLMError) else "The route interpreter returned an invalid response", 503)

    if "search" in enabled_features:
        @app.get(scoped_path(prefix, "api/search"))
        def search():
            query = request.args.get("q", "")
            if len(query) > MAX_SEARCH_QUERY_LENGTH:
                return _error_response(f"q must be at most {MAX_SEARCH_QUERY_LENGTH} characters", 400)
            return jsonify(search_records(get_db(), query))

    if "mapping" in enabled_features:
        @app.get(scoped_path(prefix, "api/map/default"))
        def map_default():
            return jsonify(openstreetmap_config())

        @app.post(scoped_path(prefix, "api/map/route"))
        def map_route():
            payload, error = _json_object()
            if error:
                return error
            try:
                start, destination = payload["start"], payload["end"]
                for point in (start, destination):
                    if not isinstance(point, dict) or not all(math.isfinite(float(point[key])) for key in ("latitude", "longitude")):
                        raise ValueError("route points must contain finite latitude and longitude values")
                mode = _route_mode(payload.get("mode"))
                return jsonify(osm_walking_route(start, destination, mode))
            except (KeyError, TypeError, ValueError, OverflowError) as exc:
                return _error_response(str(exc), 400)
            except Exception:
                current_app.logger.exception("OSM route lookup failed")
                return _error_response("OpenStreetMap route data is temporarily unavailable", 503)

        @app.post(scoped_path(prefix, "api/map/graph"))
        def map_graph():
            payload, error = _json_object()
            if error:
                return error
            try:
                start, destination = payload["start"], payload["end"]
                for point in (start, destination):
                    if not isinstance(point, dict) or not all(math.isfinite(float(point[key])) for key in ("latitude", "longitude")):
                        raise ValueError("route points must contain finite latitude and longitude values")
                return jsonify(osm_walking_graph(start, destination))
            except (KeyError, TypeError, ValueError, OverflowError) as exc:
                return _error_response(str(exc), 400)
            except Exception:
                current_app.logger.exception("OSM graph lookup failed")
                return _error_response("OpenStreetMap route data is temporarily unavailable", 503)

    if "machine-learning" in enabled_features:
        @app.get(scoped_path(prefix, "api/ml/status"))
        def ml_status():
            return jsonify(sklearn_status())

        @app.post(scoped_path(prefix, "api/ml/kmeans"))
        def ml_kmeans():
            payload, error = _json_object()
            if error:
                return error
            result, errors, status = run_kmeans(payload)
            if errors:
                return jsonify({"errors": errors, "requestId": g.request_id, **result}), status
            return jsonify(result)

    if "optimization" in enabled_features:
        @app.post(scoped_path(prefix, "api/optimize/route"))
        def optimize_route():
            payload, error = _json_object()
            if error:
                return error
            result, errors = nearest_neighbor_route(payload)
            if errors:
                return jsonify({"errors": errors, "requestId": g.request_id}), 400
            return jsonify(result)

    if "audio" in enabled_features:
        @app.post(scoped_path(prefix, "api/audio/analyze"))
        def audio_analyze():
            payload, error = _json_object()
            if error:
                return error
            result, errors = analyze_samples(payload)
            if errors:
                return jsonify({"errors": errors, "requestId": g.request_id}), 400
            return jsonify(result)

    if "sample-nodes" in enabled_features:
        @app.route(scoped_path(prefix, "api/sample-nodes"), methods=["GET", "POST"])
        def sample_nodes():
            connection = get_db()
            if request.method == "GET":
                return jsonify({"sampleNodes": fetch_sample_nodes(connection)})

            payload, error = _json_object()
            if error:
                return error
            cleaned, errors = _normalize_payload(payload)
            if errors:
                return jsonify({"errors": errors, "requestId": g.request_id}), 400

            try:
                record = insert_sample_node(connection, cleaned)
            except sqlite3.IntegrityError:
                return jsonify({"errors": ["slug already exists"], "requestId": g.request_id}), 409
            except sqlite3.OperationalError:
                current_app.logger.exception("Database write remained unavailable after retries")
                return _error_response("Database is temporarily busy; retry shortly", 503)

            return jsonify({"sampleNode": record}), 201

    @app.route(
        scoped_path(prefix, "api/<path:unmatched_path>"),
        methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    )
    def unknown_api_route(unmatched_path: str):
        return _error_response(f"Unknown or disabled API route: {unmatched_path}", 404)
