# Drift: UBC Campus Route Planner

Drift is a responsive Flask web app for finding walking routes around the UBC
Vancouver campus. Instead of optimizing only for speed, it lets a person
describe how they want the walk to feel, then compares route options using
preferences such as time, quietness, scenery, and accessibility.

The public app uses the graphical shell at `server/gizmoapp_server/templates/index.html`.
It is designed for the hosted CodingWorkspace preview and is path-prefix-safe.

## Features

- Choose a start and destination from a set of UBC landmarks.
- View the route on an interactive OpenStreetMap map.
- Drag either pin, click the map to place a pin, pan, and zoom.
- Preserve a known landmark name when a moved pin is close to it; otherwise use
  the label `Custom map point`.
- Describe a preference in natural language, such as wanting a quiet or scenic
  walk.
- Select sunny, rainy-day, or after-dark conditions.
- Compare recommended, fastest, and scenic route options.
- Adjust time, quiet/comfort, accessibility, and scenery weights manually.
- See route status and loading feedback while map data is being requested.
- Use a local interpretation fallback when the optional AI service is
  unavailable.
- Keep route lines solid and show route distance and estimated walking time.

## How Routing Works

The server downloads the UBC walking network from OpenStreetMap through the
Overpass API. It keeps the graph in `var/ubc-walking-graph.json` so subsequent
requests can reuse the campus data instead of querying Overpass every time.
Writes are atomic and a `.bak` cache is retained for recovery if the primary
cache is interrupted or corrupted.

The route search uses weighted Dijkstra's algorithm:

1. The selected points are attached to the nearest walking segments.
2. Dijkstra's algorithm explores the cached graph from the start to the
   destination.
3. Each edge cost is its walking distance multiplied by a mode-specific
   penalty.
4. The lowest-cost connected path is returned to the browser and drawn over
   the map.

Calm routes penalize roads that are likely to be busier. Scenic routes favor
paths, footways, and pedestrian ways. Crowds-avoiding routes penalize major
roads and pedestrian corridors. Accessibility is a routing preference for
connected walking paths, not a guarantee that every curb cut, elevator,
entrance, surface, or construction condition has been verified.

The graph loader tries two Overpass endpoints and performs bounded retries for
temporary failures. If both endpoints are unavailable and no valid cache is
available, the UI reports that the campus walking graph is temporarily
unavailable and asks the user to try again.

## Application Flow

- `GET /api/map/default` provides the map configuration, landmarks, and the
  expanded UBC location list.
- `POST /api/interpret-route` turns the user's text preference into a route
  mode and slider weights through the course AI helper.
- `POST /api/map/route` fetches a walking route from the cached OpenStreetMap
  graph using the selected mode.
- `GET /healthz` provides a lightweight liveness check.
- `GET /readyz` checks database readiness.

All URLs are generated from the configured application prefix. Mapping routes
are enabled in `deploy/features.txt`, and the hosted shell is selected in
`deploy/app-shell.txt`.

## Project Layout

- `server/gizmoapp_server/templates/index.html`: Drift's public page.
- `server/gizmoapp_server/static/app/main.js`: map interaction, pin handling,
  route requests, Dijkstra-based client rendering, and preference controls.
- `server/gizmoapp_server/static/app/styles.css`: Drift's responsive visual
  design.
- `server/gizmoapp_server/capabilities/mapping.py`: Overpass access, graph
  caching, server-side graph construction, and weighted route search.
- `server/gizmoapp_server/api.py`: Flask API routes and AI preference
  interpretation.
- `server/gizmoapp_server/static/app/capabilities/map.js`: OpenStreetMap tile
  URL and map projection helpers.
- `tests/`: Python API and routing smoke tests.
- `deploy/app-shell.txt`: hosted shell intent, currently `graphical`.
- `deploy/features.txt`: enabled optional capabilities, including mapping.

## Local Development

Create the environment and install the pinned dependencies:

```bash
ALLOW_NETWORK_INSTALL=1 make install
```

Initialize SQLite:

```bash
make init-db
```

Start the graphical app:

```bash
ALLOW_SERVER_RUN=1 make dev-graphical
```

The default local URL is `http://127.0.0.1:8001/`. To test deployment under a
prefix, set `GIZMOAPP_URL_PREFIX=/demo-app` before starting the server.

The optional AI interpretation uses `GIZMO_LLM_API_KEY`,
`GIZMO_LLM_BASE_URL`, and `GIZMO_LLM_MODEL` when supplied by the platform. No
credentials are stored in the repository. If those variables are unavailable,
Drift uses its bounded local preference interpretation instead.

## Validation

Run the repository checks before submitting:

```bash
make validate
```

This runs the Python tests and JavaScript structural checks without requiring
Node. For only the JavaScript check, use `make js-check`.

## Data and Limitations

- Map tiles and walking data are provided by OpenStreetMap contributors.
- Overpass availability and network access can affect first-time graph loading.
- The route estimate assumes ordinary walking and uses approximate walking
  speed for duration.
- Route quality labels are estimates from OpenStreetMap road/path categories;
  they are not live measurements of crowd levels, shade, weather, or safety.
- Accessibility information is not a substitute for a current accessibility
  audit.
- Routes are suggestions. Users should stay aware of their surroundings and
  follow campus signs and temporary closures.

## Credits

Drift was developed as a sample project for UBC's AI 100: Introduction to
Artificial Intelligence course. Map data and map tiles are from
[OpenStreetMap](https://www.openstreetmap.org/) contributors.
