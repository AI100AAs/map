import { requestJson } from "./api.js";
import { lonLatToTile, openStreetMapTileUrl } from "./capabilities/map.js";

const LOCAL_ROUTES = {
  calm: { title: "The Balanced Walk", description: "A comfortable campus crossing that trades a few minutes for quieter paths and open space.", interpretationLabel: "calming", signalOne: "quiet paths + open space", signalTwo: "balance comfort and time", score: 92, minutes: 18, distance: "1.2", traffic: "Low", weights: { time: 25, comfort: 45, access: 10, scenery: 20 } },
  crowds: { title: "The Quiet Cut-through", description: "A low-traffic route that skirts the busiest crossings, with a few extra minutes for more breathing room.", interpretationLabel: "avoid crowds", signalOne: "minimize pedestrian traffic", signalTwo: "prefer calm crossings", score: 89, minutes: 21, distance: "1.4", traffic: "Very low", weights: { time: 20, comfort: 55, access: 10, scenery: 15 } },
  accessible: { title: "The Easy-Grade Route", description: "A step-free route using accessible entrances and gentler gradients. Elevator access is noted along the way.", interpretationLabel: "step-free", signalOne: "avoid stairs + steep grades", signalTwo: "prioritize curb cuts", score: 96, minutes: 20, distance: "1.3", traffic: "Medium", weights: { time: 20, comfort: 20, access: 50, scenery: 10 } },
  scenic: { title: "The Viewfinder", description: "A longer route through gardens and notable campus spaces, prioritizing visual variety over speed.", interpretationLabel: "scenic", signalOne: "maximize points of interest", signalTwo: "prefer open-air paths", score: 87, minutes: 24, distance: "1.7", traffic: "Low", weights: { time: 15, comfort: 25, access: 10, scenery: 50 } },
};

const COMPARISONS = {
  fastest: { title: "The Quick Crossing", description: "The direct option: less time and distance, with busier crossings and fewer detours.", score: 78, minutes: 14, distance: "0.9", traffic: "High", mode: "fastest" },
  recommended: { mode: "recommended" },
  scenic: { title: "The Viewfinder", description: "The longer option: more visual interest and open space, at the cost of a few extra minutes.", score: 87, minutes: 24, distance: "1.7", traffic: "Low", mode: "scenic" },
};

// A lightweight walking graph keeps the overlay on known campus corridors.
// Junctions are deliberately split at corners so a route cannot take a
// diagonal shortcut across a building block.
const WALKING_NETWORK = {
  gageAccess: { latitude: 49.2701657, longitude: -123.2492019 },
  eastMallNorth: { latitude: 49.27005, longitude: -123.24862 },
  eastMallSouth: { latitude: 49.26882, longitude: -123.24862 },
  busLoop: { latitude: 49.26863, longitude: -123.24604 },
  busLoopWest: { latitude: 49.26863, longitude: -123.24745 },
  universityEast: { latitude: 49.26862, longitude: -123.24785 },
  universityMain: { latitude: 49.26862, longitude: -123.25275 },
  mainNorth: { latitude: 49.26858, longitude: -123.25362 },
  memorialNorth: { latitude: 49.26900, longitude: -123.25362 },
  roseTurn: { latitude: 49.26900, longitude: -123.25435 },
  roseJunction: { latitude: 49.26928, longitude: -123.2549 },
  roseGarden: { latitude: 49.26930, longitude: -123.25606 },
  moaTurn: { latitude: 49.26930, longitude: -123.25735 },
  moa: { latitude: 49.26979, longitude: -123.25849 },
  mainCenter: { latitude: 49.26772, longitude: -123.25364 },
  mainSouth: { latitude: 49.26688, longitude: -123.25364 },
  koernerTurn: { latitude: 49.26655, longitude: -123.25364 },
  koernerAccess: { latitude: 49.26655, longitude: -123.25472 },
  ams: { latitude: 49.26691, longitude: -123.24953 },
  rec: { latitude: 49.26604, longitude: -123.24791 },
};

const WALKING_EDGES = [
  ["gageAccess", "eastMallNorth", "quiet"],
  ["eastMallNorth", "eastMallSouth", "quiet"],
  ["eastMallSouth", "universityEast", "quiet"],
  ["busLoop", "universityEast", "busy"],
  ["busLoop", "busLoopWest", "busy"],
  ["busLoopWest", "universityEast", "busy"],
  ["universityEast", "universityMain", "busy"],
  ["universityMain", "mainNorth", "quiet"],
  ["mainNorth", "memorialNorth", "scenic"],
  ["memorialNorth", "roseTurn", "scenic"],
  ["roseTurn", "roseJunction", "scenic"],
  ["roseJunction", "roseGarden", "scenic"],
  ["roseGarden", "moaTurn", "scenic"],
  ["moaTurn", "moa", "scenic"],
  ["mainNorth", "mainCenter", "busy"],
  ["mainCenter", "mainSouth", "quiet"],
  ["mainSouth", "koernerTurn", "quiet"],
  ["koernerTurn", "koernerAccess", "quiet"],
  ["mainSouth", "ams", "busy"],
  ["ams", "rec", "quiet"],
  ["ams", "mainCenter", "quiet"],
];

function networkDistance(first, second) {
  const latitudeScale = 111000;
  const longitudeScale = latitudeScale * Math.cos(first.latitude * Math.PI / 180);
  return Math.hypot((first.latitude - second.latitude) * latitudeScale, (first.longitude - second.longitude) * longitudeScale);
}

function corridorProjection(point, first, second) {
  const latitudeScale = 111000;
  const longitudeScale = latitudeScale * Math.cos(point.latitude * Math.PI / 180);
  const ax = first.longitude * longitudeScale;
  const ay = first.latitude * latitudeScale;
  const bx = second.longitude * longitudeScale;
  const by = second.latitude * latitudeScale;
  const px = point.longitude * longitudeScale;
  const py = point.latitude * latitudeScale;
  const dx = bx - ax;
  const dy = by - ay;
  const fraction = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return {
    latitude: first.latitude + (second.latitude - first.latitude) * fraction,
    longitude: first.longitude + (second.longitude - first.longitude) * fraction,
    fraction,
  };
}

function walkingRoute(start, end, mode) {
  const nodes = { ...WALKING_NETWORK, start, end };
  const adjacency = Object.fromEntries(Object.keys(nodes).map((key) => [key, []]));
  WALKING_EDGES.forEach(([from, to, character]) => {
    const distance = networkDistance(nodes[from], nodes[to]);
    adjacency[from].push({ to, distance, character });
    adjacency[to].push({ to: from, distance, character });
  });

  // Snap pins to existing corridor edges. Linking a pin to nearby graph nodes
  // with a straight line was able to draw a shortcut through a building.
  const attachToCorridor = (pinName, point) => {
    WALKING_EDGES.map(([from, to, character], index) => {
      const projection = corridorProjection(point, nodes[from], nodes[to]);
      return { from, to, character, index, projection, distance: networkDistance(point, projection) };
    }).sort((first, second) => first.distance - second.distance).slice(0, 3).forEach((candidate, candidateIndex) => {
      const accessName = `${pinName}Access${candidateIndex}`;
      nodes[accessName] = candidate.projection;
      adjacency[accessName] = [];
      const edgeDistance = networkDistance(nodes[candidate.from], nodes[candidate.to]);
      const fromDistance = edgeDistance * candidate.projection.fraction;
      const toDistance = edgeDistance - fromDistance;
      const connect = (from, to, distance, character) => {
        adjacency[from].push({ to, distance, character });
        adjacency[to].push({ to: from, distance, character });
      };
      connect(pinName, accessName, candidate.distance, "access");
      connect(accessName, candidate.from, fromDistance, candidate.character);
      connect(accessName, candidate.to, toDistance, candidate.character);
    });
  };
  attachToCorridor("start", start);
  attachToCorridor("end", end);

  const distance = Object.fromEntries(Object.keys(nodes).map((key) => [key, Infinity]));
  const previous = {};
  const pending = new Set(Object.keys(nodes));
  distance.start = 0;
  while (pending.size) {
    const current = [...pending].sort((first, second) => distance[first] - distance[second])[0];
    pending.delete(current);
    if (current === "end" || distance[current] === Infinity) break;
    adjacency[current].forEach(({ to, distance: length, character }) => {
      if (!pending.has(to)) return;
      const preferencePenalty = mode === "scenic" && character !== "scenic" ? 1.35
        : mode === "crowds" && character === "busy" ? 1.7
          : mode === "accessible" && character === "busy" ? 1.12 : 1;
      const candidate = distance[current] + length * preferencePenalty;
      if (candidate < distance[to]) { distance[to] = candidate; previous[to] = current; }
    });
  }

  if (distance.end === Infinity) return [];
  const route = [];
  for (let current = "end"; current; current = previous[current]) route.unshift(nodes[current]);
  return route;
}

function graphRoute(graph, start, end, mode) {
  if (!graph?.nodes || !graph.edges?.length) return [];
  const nodes = Object.fromEntries(Object.entries(graph.nodes).map(([key, [longitude, latitude]]) => [key, { longitude, latitude }]));
  const adjacency = Object.fromEntries(Object.keys(nodes).map((key) => [key, []]));
  graph.edges.forEach(([first, second, length, highway]) => {
    if (!adjacency[first] || !adjacency[second]) return;
    adjacency[first].push({ to: second, length, highway });
    adjacency[second].push({ to: first, length, highway });
  });
  const nearest = (point) => Object.keys(nodes).reduce((best, key) => (
    networkDistance(point, nodes[key]) < networkDistance(point, nodes[best]) ? key : best
  ));
  const source = nearest(start);
  const target = nearest(end);
  const distances = { [source]: 0 };
  const previous = {};
  const pending = new Set(Object.keys(nodes));
  while (pending.size) {
    const current = [...pending].sort((first, second) => (distances[first] ?? Infinity) - (distances[second] ?? Infinity))[0];
    pending.delete(current);
    if (current === target || distances[current] === undefined) break;
    adjacency[current].forEach(({ to, length, highway }) => {
      if (!pending.has(to)) return;
      const penalty = mode === "scenic" && !["path", "footway", "pedestrian"].includes(highway) ? 1.25
        : mode === "crowds" && ["primary", "secondary", "tertiary", "pedestrian"].includes(highway) ? 1.35
          : mode === "calm" && ["primary", "secondary", "tertiary", "residential"].includes(highway) ? 1.18 : 1;
      const candidate = distances[current] + length * penalty;
      if (candidate < (distances[to] ?? Infinity)) {
        distances[to] = candidate;
        previous[to] = current;
      }
    });
  }
  if (source === target || distances[target] === undefined) return [start, end];
  const route = [target];
  while (route[0] !== source) route.unshift(previous[route[0]]);
  return [start, ...route.map((key) => nodes[key]), end];
}

function modeFor(text) {
  const value = text.toLowerCase();
  if (value.includes("step") || value.includes("accessible") || value.includes("wheelchair")) return "accessible";
  if (value.includes("crowd") || value.includes("busy") || value.includes("quiet") || value.includes("peace")) return "crowds";
  if (value.includes("scenic") || value.includes("view") || value.includes("green") || value.includes("garden")) return "scenic";
  return "calm";
}

function bootstrap() {
  const runtime = window.GizmoAppRuntime;
  if (!runtime) throw new Error("The shared app runtime did not load.");
  const config = runtime.readConfig();
  const prompt = document.getElementById("constraint-input");
  const from = document.getElementById("from-location");
  const to = document.getElementById("to-location");
  const conditions = document.querySelectorAll(".preference");
  const generate = document.getElementById("generate-route");
  const status = document.getElementById("route-status");
  const description = document.getElementById("route-description");
  const title = document.getElementById("route-title");
  const score = document.querySelector(".match-score");
  const stats = document.querySelectorAll(".route-stats strong");
  const mapHelp = document.querySelector(".map-help");
  let selectedCondition = "sunny";
  let requestNumber = 0;
  let routeRequestNumber = 0;

  const map = document.getElementById("campus-map");
  const tileViewport = document.getElementById("osm-map");
  let mapConfig;
  let mapLocation;
  let mapZoom;
  let currentPoints;
  let routeGeometry = [];
  const routeMetrics = {};
  let selectedRoute = "recommended";
  let pinEndpoint = "start";
  let dragging = false;
  let dragMoved = false;
  let dragStart;
  let dragOrigin;
  let draggingPin = null;
  let draggedPoint = false;

  function projectLocation(location) {
    const scale = 2 ** mapZoom;
    const latRad = location.latitude * Math.PI / 180;
    return {
      x: (location.longitude + 180) / 360 * scale * 256,
      y: (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * scale * 256,
    };
  }

  function updateLandmarkOverlays(originX, originY) {
    if (!mapConfig.landmarks || !currentPoints) return;
    const mapWidth = tileViewport.clientWidth;
    const mapHeight = tileViewport.clientHeight;
    Object.entries(currentPoints).forEach(([key, landmark]) => {
      const pin = map.querySelector(`[data-endpoint="${key}"]`);
      if (!pin) return;
      const point = projectLocation(landmark);
      pin.style.left = `${point.x - originX + mapWidth / 2}px`;
      pin.style.top = `${point.y - originY + mapHeight / 2}px`;
      const label = pin.querySelector("span");
      if (label) label.textContent = landmark.label;
      pin.title = `${landmark.label} · ${landmark.latitude.toFixed(6)}, ${landmark.longitude.toFixed(6)}`;
    });

    const toViewBox = (value, size, viewBoxSize) => value / size * viewBoxSize;
    const routeMode = selectedRoute === "recommended"
      ? (map.dataset.routeMode || "calm")
      : selectedRoute;
    const routePath = routeGeometry.map(([longitude, latitude], index) => {
      const point = projectLocation({ latitude, longitude });
      const x = toViewBox(point.x - originX + mapWidth / 2, mapWidth, 700);
      const y = toViewBox(point.y - originY + mapHeight / 2, mapHeight, 430);
      return `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(" ");
    map.querySelectorAll(".route-layer path").forEach((path) => { path.setAttribute("d", routePath); });
  }

  async function loadRoute() {
    if (!currentPoints?.start || !currentPoints?.end || !mapConfig) return;
    const currentRouteRequest = ++routeRequestNumber;
    const startPoint = currentPoints.start;
    const endPoint = currentPoints.end;
    const routeMode = selectedRoute === "recommended" ? (map.dataset.routeMode || "calm") : selectedRoute;
    routeGeometry = [];
    renderMap();
    status.classList.add("is-loading");
    status.setAttribute("aria-busy", "true");
    status.textContent = "Updating walking route…";
    try {
      try {
          const route = await requestJson(`${config.apiBase}/map/route`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ start: startPoint, end: endPoint, mode: routeMode }),
            timeoutMs: Math.min(config.requestTimeoutMs, 30000),
          });
          if (currentRouteRequest !== routeRequestNumber) return;
          routeGeometry = route.coordinates || [];
          if (routeGeometry.length < 2) throw new Error("OpenStreetMap returned an empty walking route");
          routeMetrics[routeMode] = {
            minutes: route.minutes,
            distance: (Number(route.distance) / 1000).toFixed(1),
          };
          updateRouteComparison(routeMode);
          renderMap();
          status.textContent = `OpenStreetMap walking route · ${(Number(route.distance) / 1000).toFixed(2)} km.`;
        } catch (error) {
          if (currentRouteRequest !== routeRequestNumber) return;
          routeGeometry = [];
          renderMap();
          status.textContent = "The campus walking graph is temporarily unavailable. Try again shortly.";
          console.info("Campus walking graph unavailable", error);
        }
    } finally {
      if (currentRouteRequest === routeRequestNumber) {
        status.classList.remove("is-loading");
        status.setAttribute("aria-busy", "false");
      }
    }
  }

  function updateRouteComparison(routeMode) {
    const comparisonMode = routeMode === "calm" ? "recommended" : routeMode;
    const metrics = routeMetrics[routeMode];
    if (!metrics) return;
    const button = document.querySelector(`[data-route="${comparisonMode}"] strong`);
    if (button) button.textContent = `${metrics.minutes}m`;
    if (selectedRoute !== comparisonMode) return;
    const current = comparisonMode === "recommended"
      ? localInterpretation(prompt.value)
      : { ...localInterpretation(prompt.value), ...COMPARISONS[comparisonMode] };
    updateStats({ ...current, minutes: metrics.minutes, distance: metrics.distance }, { syncPreferences: false });
  }

  function renderMap() {
    if (!mapConfig || !mapLocation) return;
    const tile = lonLatToTile({ ...mapLocation, zoom: mapZoom });
    const tileSize = 256;
    const originX = (mapLocation.longitude + 180) / 360 * (2 ** mapZoom) * tileSize;
    const latRad = mapLocation.latitude * Math.PI / 180;
    const originY = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * (2 ** mapZoom) * tileSize;
    tileViewport.replaceChildren();
    for (let x = tile.x - 2; x <= tile.x + 2; x += 1) {
      for (let y = tile.y - 2; y <= tile.y + 2; y += 1) {
        const image = document.createElement("img");
        image.className = "osm-tile";
        image.alt = "";
        image.loading = "eager";
        image.src = openStreetMapTileUrl(mapConfig.tileUrlTemplate, { x, y, z: mapZoom });
        image.style.left = `${(x * tileSize) - originX + tileViewport.clientWidth / 2}px`;
        image.style.top = `${(y * tileSize) - originY + tileViewport.clientHeight / 2}px`;
        tileViewport.append(image);
      }
    }
    updateLandmarkOverlays(originX, originY);
    map.querySelector(".map-loading").hidden = true;
    map.querySelector(".map-attribution").textContent = `© OpenStreetMap contributors · ${mapConfig.defaultLocation.label}`;
  }

  async function initializeMap() {
    try {
      mapConfig = await requestJson(`${config.apiBase}/map/default`);
      mapLocation = mapConfig.defaultLocation;
      mapZoom = mapLocation.zoom;
      currentPoints = { ...mapConfig.landmarks };
      [from, to].forEach((select) => {
        select.replaceChildren(...mapConfig.locations.map((location) => {
          const option = document.createElement("option");
          option.value = location.label;
          option.textContent = location.label;
          return option;
        }));
      });
      from.value = currentPoints.start.label;
      to.value = currentPoints.end.label;
      renderMap();
      loadRoute();
    } catch (error) {
      map.querySelector(".map-loading").textContent = "Map tiles are unavailable. Check your connection.";
      console.info("OpenStreetMap tiles unavailable", error);
    }
  }

  function locationFor(label) {
    return mapConfig?.locations?.find((location) => location.label === label)
      || Object.values(currentPoints || {}).find((location) => location.label === label);
  }

  function labelPoint(point) {
    const nearest = mapConfig?.locations
      ?.map((location) => ({ location, distance: networkDistance(point, location) }))
      .sort((first, second) => first.distance - second.distance)[0];
    return {
      ...point,
      label: nearest && nearest.distance <= 45 ? nearest.location.label : "Custom map point",
    };
  }

  function selectPoint(endpoint, location) {
    if (!location || !currentPoints) return;
    currentPoints[endpoint] = location;
    const select = endpoint === "start" ? from : to;
    select.value = location.label;
    renderMap();
    loadRoute();
  }

  function pointFromEvent(event) {
    const rect = tileViewport.getBoundingClientRect();
    const scale = 2 ** mapZoom;
    const originX = (mapLocation.longitude + 180) / 360 * scale * 256;
    const latRad = mapLocation.latitude * Math.PI / 180;
    const originY = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * scale * 256;
    const pixelX = originX + event.clientX - rect.left - rect.width / 2;
    const pixelY = originY + event.clientY - rect.top - rect.height / 2;
    const longitude = Math.max(-180, Math.min(180, pixelX / (scale * 256) * 360 - 180));
    const mercator = Math.PI - (2 * Math.PI * pixelY) / (scale * 256);
    const latitude = Math.max(-85.051129, Math.min(85.051129, 180 / Math.PI * Math.atan(Math.sinh(mercator))));
    return { latitude, longitude };
  }

  function updateDraggedPin(event) {
    const endpoint = draggingPin.dataset.endpoint;
    const point = pointFromEvent(event);
    const current = currentPoints[endpoint];
    currentPoints[endpoint] = labelPoint({ ...current, ...point });
    const select = endpoint === "start" ? from : to;
    let option = [...select.options].find((item) => item.value === currentPoints[endpoint].label);
    if (!option) {
      option = document.createElement("option");
      option.value = currentPoints[endpoint].label;
      option.textContent = option.value;
      select.append(option);
    }
    select.value = option.value;
    renderMap();
    status.textContent = `Moving ${endpoint === "start" ? "starting point" : "destination"}…`;
  }

  function setPinEndpoint(endpoint) {
    pinEndpoint = endpoint;
    const pointName = endpoint === "start" ? "starting point" : "destination";
    const button = document.getElementById(endpoint === "start" ? "use-location" : "use-destination");
    map.focus();
    status.textContent = `Click the map to place your ${pointName} pin.`;
    if (button) button.setAttribute("aria-pressed", "true");
    ["use-location", "use-destination"].forEach((id) => {
      if (id !== button?.id) document.getElementById(id)?.setAttribute("aria-pressed", "false");
    });
    if (mapHelp) mapHelp.innerHTML = `<strong>Map actions</strong> Drag to pan · click to pin your ${pointName} · use + / − to zoom`;
  }

  function addDroppedPin(latitude, longitude) {
    const pointName = pinEndpoint === "start" ? "start" : "destination";
    const location = labelPoint({ latitude, longitude });
    const select = pinEndpoint === "start" ? from : to;
    let option = [...select.options].find((item) => item.value === location.label);
    if (!option) {
      option = document.createElement("option");
      option.value = location.label;
      option.textContent = location.label;
      select.append(option);
    }
    select.value = location.label;
    selectPoint(pinEndpoint, location);
    status.textContent = `${pointName[0].toUpperCase()}${pointName.slice(1)} pinned at ${latitude.toFixed(5)}, ${longitude.toFixed(5)}.`;
  }

  function updateStats(route, { syncPreferences = true } = {}) {
    title.textContent = route.title;
    description.textContent = route.description;
    score.textContent = `${route.score}% match`;
    [route.minutes, route.distance, route.traffic].forEach((value, index) => { if (stats[index]) stats[index].textContent = value; });
    if (syncPreferences && route.weights) {
      Object.entries(route.weights).forEach(([key, value]) => {
        const slider = document.getElementById(`pref-${key}`);
        const output = document.getElementById(`pref-${key}-value`);
        if (slider) slider.value = value;
        if (output) output.textContent = `${value}%`;
      });
    }
  }

  function localInterpretation(text) {
    const mode = modeFor(text);
    return { ...LOCAL_ROUTES[mode], mode };
  }

  function modeFromPreferences() {
    const weights = Object.fromEntries([...document.querySelectorAll(".slider-row input")].map((slider) => [slider.id.replace("pref-", ""), Number(slider.value)]));
    if (weights.access >= weights.time && weights.access >= weights.comfort && weights.access >= weights.scenery) return "accessible";
    if (weights.scenery >= weights.time && weights.scenery >= weights.comfort) return "scenic";
    if (weights.comfort >= weights.time) return "crowds";
    return "calm";
  }

  async function generateRoute() {
    const text = prompt.value.trim();
    if (!from.value.trim() || !to.value.trim()) {
      status.textContent = "Add a starting point and destination first.";
      (from.value.trim() ? to : from).focus();
      return;
    }
    if (!text) prompt.value = "Find a comfortable route with open space";
    const currentRequest = ++requestNumber;
    generate.disabled = true;
    generate.innerHTML = "Interpreting <span>…</span>";
    status.textContent = "Translating your preference into route signals…";
    let route;
    try {
      route = await requestJson(`${config.apiBase}/interpret-route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: from.value.trim(), to: to.value.trim(), prompt: prompt.value.trim(), condition: selectedCondition }),
        timeoutMs: Math.min(config.requestTimeoutMs, 12000),
      });
      route.mode = route.mode || modeFor(prompt.value);
      status.textContent = "Route shaped around your priorities and campus corridors.";
    } catch (error) {
      route = localInterpretation(prompt.value);
      status.textContent = "Using Drift's offline route guide. AI interpretation is unavailable right now.";
      console.info("Drift used local route guidance", error);
    } finally {
      if (currentRequest === requestNumber) {
        generate.disabled = false;
        generate.innerHTML = "Route updated <span>✓</span>";
        window.setTimeout(() => { generate.innerHTML = "Find my route <span>→</span>"; }, 1800);
      }
    }
    if (currentRequest !== requestNumber) return;
    updateStats(route);
    document.getElementById("campus-map").dataset.routeMode = selectedRoute === "recommended" ? route.mode : selectedRoute;
    renderMap();
    loadRoute();
  }

  conditions.forEach((button) => button.addEventListener("click", () => {
    selectedCondition = button.dataset.condition;
    conditions.forEach((item) => item.classList.toggle("active", item === button));
    document.getElementById("map-condition").textContent = selectedCondition === "rain" ? "Rain-aware" : selectedCondition === "after-dark" ? "Well-lit paths" : "Sunny";
    status.textContent = `${button.textContent.trim()} routing selected.`;
    loadRoute();
  }));
  generate.addEventListener("click", generateRoute);
  prompt.addEventListener("keydown", (event) => { if (event.key === "Enter") generateRoute(); });
   document.getElementById("swap-locations").addEventListener("click", () => { [from.value, to.value] = [to.value, from.value]; [currentPoints.start, currentPoints.end] = [currentPoints.end, currentPoints.start]; renderMap(); status.textContent = "Starting point and destination swapped."; loadRoute(); });
     document.getElementById("use-location").addEventListener("click", () => setPinEndpoint("start"));
     document.getElementById("use-destination").addEventListener("click", () => setPinEndpoint("end"));
    from.addEventListener("change", () => { selectPoint("start", locationFor(from.value)); });
    to.addEventListener("change", () => { selectPoint("end", locationFor(to.value)); });
   document.querySelectorAll("[data-route]").forEach((button) => button.addEventListener("click", () => {
     selectedRoute = button.dataset.route;
     document.querySelectorAll("[data-route]").forEach((item) => item.classList.toggle("selected", item === button));
     const comparison = COMPARISONS[selectedRoute];
      if (selectedRoute === "recommended") {
         updateStats(localInterpretation(prompt.value), { syncPreferences: false });
       status.textContent = "Best fit combines the preferences in your sliders.";
     } else {
        updateStats({ ...localInterpretation(prompt.value), ...comparison }, { syncPreferences: false });
       status.textContent = `${button.textContent.trim()} selected. Compare its time, distance, and traffic above.`;
      }
      updateRouteComparison(selectedRoute === "recommended" ? "calm" : selectedRoute);
      map.dataset.routeMode = selectedRoute;
      renderMap();
      loadRoute();
   }));
    document.querySelectorAll(".slider-row input").forEach((slider) => slider.addEventListener("input", () => {
     document.getElementById(`${slider.id}-value`).textContent = `${slider.value}%`;
      selectedRoute = "recommended";
      document.querySelectorAll("[data-route]").forEach((item) => item.classList.toggle("selected", item.dataset.route === "recommended"));
      map.dataset.routeMode = modeFromPreferences();
      status.textContent = "Preference weight changed. Updating walking route…";
      renderMap();
      loadRoute();
    }));
    document.getElementById("reset-preferences").addEventListener("click", () => {
      updateStats(localInterpretation(prompt.value));
      map.dataset.routeMode = modeFromPreferences();
      status.textContent = "AI-filled preference weights restored. Updating walking route…";
      renderMap();
      loadRoute();
    });
  const settingsPanel = document.getElementById("settings-panel");
  document.getElementById("settings-toggle").addEventListener("click", () => { settingsPanel.hidden = !settingsPanel.hidden; document.getElementById("settings-toggle").setAttribute("aria-expanded", String(!settingsPanel.hidden)); });
   document.getElementById("settings-close").addEventListener("click", () => { settingsPanel.hidden = true; document.getElementById("settings-toggle").setAttribute("aria-expanded", "false"); });
   const darkMode = document.getElementById("dark-mode");
   darkMode.addEventListener("change", () => {
     document.body.classList.toggle("dark-mode", darkMode.checked);
     document.querySelector('meta[name="theme-color"]').setAttribute("content", darkMode.checked ? "#17231f" : "#f7f9f5");
   });
  document.getElementById("map-center").addEventListener("click", () => { if (mapConfig) { mapLocation = mapConfig.defaultLocation; mapZoom = mapLocation.zoom; renderMap(); } });
  document.getElementById("map-zoom-in").addEventListener("click", () => { if (mapConfig) { mapZoom = Math.min(18, mapZoom + 1); renderMap(); } });
     document.getElementById("map-zoom-out").addEventListener("click", () => { if (mapConfig) { mapZoom = Math.max(12, mapZoom - 1); renderMap(); } });
    map.tabIndex = 0;
     map.querySelectorAll(".map-pin").forEach((pin) => {
       pin.addEventListener("pointerdown", (event) => {
         event.stopPropagation();
         draggingPin = pin;
         draggedPoint = false;
         pin.setPointerCapture(event.pointerId);
         status.textContent = `Drag to move the ${pin.dataset.endpoint === "start" ? "starting point" : "destination"}.`;
       });
       pin.addEventListener("pointermove", (event) => {
         if (draggingPin !== pin) return;
         if (Math.abs(event.movementX) + Math.abs(event.movementY) > 2) draggedPoint = true;
         if (draggedPoint) updateDraggedPin(event);
       });
       pin.addEventListener("pointerup", (event) => {
         if (draggingPin !== pin) return;
         pin.releasePointerCapture(event.pointerId);
         draggingPin = null;
         if (draggedPoint) {
           draggedPoint = false;
           loadRoute();
         }
       });
     });
     map.addEventListener("pointerdown", (event) => {
      if (!mapConfig || event.target.closest("button, select, .map-control, .map-pin")) return;
      dragging = true;
      dragMoved = false;
      dragStart = { x: event.clientX, y: event.clientY };
      dragOrigin = { ...mapLocation };
      map.setPointerCapture(event.pointerId);
    });
    map.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - dragStart.x;
      const dy = event.clientY - dragStart.y;
      dragMoved = dragMoved || Math.abs(dx) + Math.abs(dy) > 4;
      if (!dragMoved) return;
      const scale = 2 ** mapZoom;
      const worldX = (dragOrigin.longitude + 180) / 360 * scale * 256 - dx;
      const latRad = dragOrigin.latitude * Math.PI / 180;
      const worldY = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * scale * 256 - dy;
      mapLocation.longitude = worldX / (scale * 256) * 360 - 180;
      mapLocation.latitude = 180 / Math.PI * Math.atan(Math.sinh(Math.PI - (2 * Math.PI * worldY) / (scale * 256)));
      renderMap();
        status.textContent = `Map moved. Click a point to place your ${pinEndpoint === "start" ? "starting point" : "destination"} pin.`;
    });
    map.addEventListener("pointerup", (event) => {
      if (!dragging) return;
      dragging = false;
      map.releasePointerCapture(event.pointerId);
    });
     map.addEventListener("click", (event) => {
       if (draggingPin || draggedPoint) { draggedPoint = false; return; }
       if (dragMoved) { dragMoved = false; return; }
      if (!mapConfig || event.target.closest("button, select, .map-control, .map-pin, .map-loading, .map-attribution, .map-legend, .map-help")) return;
       const { latitude, longitude } = pointFromEvent(event);
         addDroppedPin(latitude, longitude);
    });
  window.addEventListener("resize", renderMap);
  initializeMap();
  runtime.markReady();
}

try { bootstrap(); } catch (error) { window.GizmoAppRuntime?.showFatalError(error); }
