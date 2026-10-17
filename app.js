import { VectorTile } from 'https://esm.sh/@mapbox/vector-tile@3.0.0?bundle';
import { PbfReader } from 'https://esm.sh/pbf@5.1.2?bundle';

const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([39.5, -98.35], 4);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);

const destinationInput = document.querySelector('#destination');
const searchButton = document.querySelector('#search-destination');
const placeResults = document.querySelector('#place-results');
const routeButton = document.querySelector('#route-button');
const cameraFile = document.querySelector('#camera-file');
const cameraCount = document.querySelector('#camera-count');
const uploadLabel = document.querySelector('#upload-label');
const cameraToggle = document.querySelector('#show-cameras');
const areaLoadButton = document.querySelector('#load-area-button');
const bufferInput = document.querySelector('#buffer');
const bufferOutput = document.querySelector('#buffer-output');
const statusBox = document.querySelector('#status');
const resultBox = document.querySelector('#route-result');
const routeSummary = document.querySelector('#route-summary');
const stepsList = document.querySelector('#steps');
const mapCaption = document.querySelector('#map-caption');
const clearButton = document.querySelector('#clear-button');
const privacyChoiceButton = document.querySelector('#privacy-choice');
const standardChoiceButton = document.querySelector('#standard-choice');
const trailButton = document.querySelector('#trail-button');
const trailStatus = document.querySelector('#trail-status');
const trailDistanceOutput = document.querySelector('#trail-distance');
const trailElapsedOutput = document.querySelector('#trail-elapsed');
const clearTrailButton = document.querySelector('#clear-trail');

let cameras = [];
let importedCameras = [];
let cameraIndexPromise = null;
let cameraIndex = null;
let selectedDestination = null;
let pendingPlaces = [];
let routeOptions = [];
let selectedRouteId = null;
let routeLayers = new Map();
let routeStartMarker = null;
let routeEndMarker = null;
const tileCache = new Map();
const cameraLayer = L.layerGroup().addTo(map);
const cameraRenderer = L.canvas({ padding: 0.4 });
let trailWatchId = null;
let trailTimerId = null;
let trailStartedAt = null;
let trailPoints = [];
let trailDistance = 0;
let latestFix = null;
let trailLine = L.polyline([], { color: '#ee9654', weight: 4, opacity: 0.95, lineCap: 'round', lineJoin: 'round' }).addTo(map);
let trailMarker = null;
const MAX_IMPORT_POINTS = 20000;
const MAX_VISIBLE_MARKERS = 3500;
const MAX_ROUTE_TILES = 300;
const MAX_AREA_TILES = 100;
const EARTH_RADIUS = 6371000;
const CAMERA_ROUTE_ZOOM = 10;
const FLOCKHOPPER_ROUTE_API = 'https://api.dontgetflocked.com/api/v1/route';
const OSRM_ROUTE_API = 'https://router.project-osrm.org/route/v1/driving/';

bufferInput.addEventListener('input', () => { bufferOutput.value = bufferInput.value + ' m'; });
cameraToggle.addEventListener('change', renderCameraLayer);
cameraFile.addEventListener('change', importCameraFile);
routeButton.addEventListener('click', startRoute);
searchButton.addEventListener('click', () => searchDestination(false));
areaLoadButton.addEventListener('click', loadMapArea);
clearButton.addEventListener('click', clearRoute);
privacyChoiceButton.addEventListener('click', () => selectRoute('privacy'));
standardChoiceButton.addEventListener('click', () => selectRoute('standard'));
trailButton.addEventListener('click', toggleGpsTrail);
clearTrailButton.addEventListener('click', clearGpsTrail);
destinationInput.addEventListener('input', () => {
  selectedDestination = null;
  placeResults.hidden = true;
});
destinationInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); startRoute(); }
  if (event.key === 'Escape') placeResults.hidden = true;
});
placeResults.addEventListener('click', event => {
  const button = event.target.closest('[data-place-index]');
  if (!button) return;
  const place = pendingPlaces[Number(button.dataset.placeIndex)];
  if (!place) return;
  selectedDestination = place;
  destinationInput.value = place.label;
  placeResults.hidden = true;
  setStatus('Destination selected: ' + place.label + '. Press route when ready.', 'success');
});
map.on('moveend zoomend', renderCameraLayer);

function setStatus(message, kind = '') {
  statusBox.textContent = message;
  statusBox.className = 'status' + (kind ? ' ' + kind : '');
}

function parseCoordinateInput(text) {
  const match = text.trim().match(/^(-?[0-9]+(?:\.[0-9]+)?)\s*,\s*(-?[0-9]+(?:\.[0-9]+)?)$/);
  if (!match) return null;
  const lat = Number(match[1]), lng = Number(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { label: lat.toFixed(5) + ', ' + lng.toFixed(5), lat, lng };
}

async function geocodeQuery(query) {
  let response;
  try {
    response = await fetch('/api/geocode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
  } catch {
    throw new Error('Place search is unavailable. You can enter coordinates as latitude, longitude.');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Place search failed.');
  return data.places || [];
}

async function searchDestination(routeAfterSingle = false) {
  const query = destinationInput.value.trim();
  if (!query) return setStatus('Enter a destination or coordinates as latitude, longitude.', 'error');
  const coordinates = parseCoordinateInput(query);
  if (coordinates) {
    selectedDestination = coordinates;
    placeResults.hidden = true;
    if (routeAfterSingle) return startRoute();
    return setStatus('Coordinates selected. Press route when ready.', 'success');
  }
  searchButton.disabled = true;
  searchButton.textContent = '…';
  try {
    pendingPlaces = await geocodeQuery(query);
    if (!pendingPlaces.length) return setStatus('No places found. Try a fuller address or paste coordinates.', 'error');
    if (pendingPlaces.length === 1) {
      selectedDestination = pendingPlaces[0];
      destinationInput.value = selectedDestination.label;
      placeResults.hidden = true;
      if (routeAfterSingle) return startRoute();
      return setStatus('Destination selected: ' + selectedDestination.label + '.', 'success');
    }
    renderPlaceResults(pendingPlaces);
    setStatus('Choose the matching destination from the results.', '');
  } catch (error) {
    setStatus(error.message || 'Place search failed.', 'error');
  } finally {
    searchButton.disabled = false;
    searchButton.textContent = 'Find';
  }
}

function renderPlaceResults(places) {
  placeResults.replaceChildren();
  places.forEach((place, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'place-result';
    button.dataset.placeIndex = String(index);
    button.setAttribute('role', 'option');
    const label = document.createElement('strong'); label.textContent = place.label;
    const detail = document.createElement('small'); detail.textContent = place.detail || 'OpenStreetMap place';
    button.append(label, detail);
    placeResults.append(button);
  });
  placeResults.hidden = false;
}

function getCurrentLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser does not support location access.'));
    navigator.geolocation.getCurrentPosition(position => {
      latestFix = { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy, timestamp: position.timestamp || Date.now() };
      resolve({ lat: latestFix.lat, lng: latestFix.lng });
    }, error => reject(new Error(error.code === 1 ? 'Location permission was declined. Allow location access, then try again.' : error.code === 2 ? 'Your location could not be determined. Try again in a clearer GPS area.' : 'Location took too long. Try again.')), { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}

async function startRoute() {
  if (routeButton.disabled) return;
  routeButton.disabled = true;
  routeButton.querySelector('span:first-child').textContent = 'Preparing route…';
  resultBox.hidden = true;
  try {
    if (!selectedDestination) {
      const direct = parseCoordinateInput(destinationInput.value);
      if (direct) selectedDestination = direct;
      else {
        const places = await geocodeQuery(destinationInput.value.trim());
        if (!places.length) throw new Error('No places found. Try a fuller address or paste coordinates.');
        if (places.length > 1) {
          pendingPlaces = places;
          renderPlaceResults(places);
          setStatus('Choose the matching destination from the results before routing.');
          return;
        }
        selectedDestination = places[0];
        destinationInput.value = selectedDestination.label;
      }
    }
    setStatus('Requesting your location. Your browser asks before sharing GPS.');
    const freshFix = latestFix && Date.now() - latestFix.timestamp < 30000;
    const origin = freshFix ? { lat: latestFix.lat, lng: latestFix.lng } : await getCurrentLocation();
    const straightDistance = haversineMeters([origin.lat, origin.lng], [selectedDestination.lat, selectedDestination.lng]);
    let result;
    let routeSource;
    let fallbackNote = '';
    if (isContiguousUS(origin) && isContiguousUS(selectedDestination) && straightDistance <= 300 * 1609.34) {
      try {
        setStatus('Requesting keyless camera-aware routes from DeFlock Maps…');
        result = await requestDeFlockRoutes(origin, selectedDestination, Number(bufferInput.value));
        routeSource = 'deflock';
      } catch (error) {
        fallbackNote = 'DeFlock privacy routing was unavailable (' + error.message + '); using keyless road routes instead.';
      }
    } else {
      fallbackNote = 'Camera-aware route optimization is currently limited to US trips under 300 miles; using keyless road routes and comparing available alternatives.';
    }
    if (!result) {
      setStatus('Requesting keyless OpenStreetMap routes…');
      result = await requestOSRMRoutes(origin, selectedDestination);
      routeSource = 'osrm';
    }

    const index = await getCameraIndex();
    const tileResults = await Promise.all(result.choices.map(choice => loadRouteCameraTiles(choice.route, Number(bufferInput.value)).catch(error => ({ warning: error.message, updatedAt: '' }))));
    const tileWarning = tileResults.find(tile => tile.warning)?.warning || '';
    const exposureDataAvailable = cameras.length > 0 || tileResults.some(tile => tile.tilesLoaded > 0);
    result.choices.forEach(choice => {
      if (!Number.isFinite(choice.cameraCount)) choice.cameraCount = exposureDataAvailable ? findNearbyCameras(choice.route, Number(bufferInput.value)).length : null;
    });
    routeOptions = arrangeRouteChoices(result.choices, routeSource);
    selectedRouteId = 'privacy';
    if (!routeOptions[0]) throw new Error('No route was returned.');
    renderRouteChoices(origin, selectedDestination, routeSource);
    resultBox.hidden = false;
    const current = routeOptions.find(option => option.id === selectedRouteId) || routeOptions[0];
    const detour = routeOptions[1] && routeDistance(routeOptions[1].route) > 0 ? Math.max(0, Math.round((routeDistance(current.route) / routeDistance(routeOptions[1].route) - 1) * 100)) : 0;
    const parts = [];
    if (routeSource === 'deflock') parts.push('Keyless DeFlock route comparison');
    else parts.push(fallbackNote || 'Keyless road route comparison');
    if (routeSource === 'deflock' && routeOptions[1]) parts.push('lower-camera option trades ' + detour + '% more distance for fewer mapped ALPRs');
    if (tileWarning) parts.push(tileWarning);
    const sourceUpdated = tileResults.find(tile => tile.updatedAt)?.updatedAt;
    if (sourceUpdated) parts.push('camera tile feed updated ' + formatSourceDate(sourceUpdated));
    parts.push('camera locations may be missing or outdated');
    setStatus(parts.join('. ') + '.', tileWarning ? 'warning' : 'success');
    mapCaption.textContent = cameras.length.toLocaleString() + ' camera points loaded · GPS not retained';
  } catch (error) {
    setStatus(error.message || 'Could not calculate routes. Try again.', 'error');
  } finally {
    routeButton.disabled = false;
    routeButton.querySelector('span:first-child').textContent = 'Plan route from my location';
  }
}

function isContiguousUS(point) {
  return point.lat >= 24 && point.lat <= 50.5 && point.lng >= -125 && point.lng <= -66;
}

async function requestDeFlockRoutes(origin, destination, clearance) {
  let response;
  try {
    response = await fetch(FLOCKHOPPER_ROUTE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        origin: { lat: origin.lat, lon: origin.lng },
        destination: { lat: destination.lat, lon: destination.lng },
        format: 'full',
        costing: 'auto',
        cameraDistanceMeters: clearance,
        useDirectionalZones: true,
      }),
    });
  } catch {
    throw new Error('service could not be reached');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || !data.ok || !data.result) {
    const message = data && data.error ? data.error : 'service did not return route options';
    throw new Error(message);
  }
  const result = data.result;
  const normal = result.normalRoute;
  const avoidance = result.avoidanceRoute;
  if (!normal?.route || !avoidance?.route) throw new Error('service returned incomplete route options');
  return {
    choices: [
      { id: 'privacy', label: 'Fewer cameras', route: avoidance.route, cameraCount: (avoidance.camerasOnRoute || []).length, source: 'deflock' },
      { id: 'standard', label: 'Standard route', route: normal.route, cameraCount: (normal.camerasOnRoute || []).length, source: 'deflock' },
    ],
  };
}

async function requestOSRMRoutes(origin, destination) {
  const coords = origin.lng.toFixed(6) + ',' + origin.lat.toFixed(6) + ';' + destination.lng.toFixed(6) + ',' + destination.lat.toFixed(6);
  const url = OSRM_ROUTE_API + coords + '?alternatives=1&steps=true&geometries=geojson&overview=full';
  let response;
  try { response = await fetch(url); }
  catch { throw new Error('OpenStreetMap routing service could not be reached.'); }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.code !== 'Ok' || !Array.isArray(data.routes) || !data.routes.length) {
    throw new Error(data?.message || data?.code || 'No road route was found.');
  }
  const choices = data.routes.slice(0, 2).map((route, index) => ({
    id: 'osrm-' + index,
    label: index === 0 ? 'Fastest route' : 'Alternative route',
    route: {
      geometry: route.geometry,
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      maneuvers: (route.legs || []).flatMap(leg => leg.steps || []).map(step => ({
        instruction: describeOSRMStep(step),
        length: step.distance,
        time: step.duration,
      })),
    },
    cameraCount: null,
    source: 'osrm',
  }));
  return { choices };
}

function describeOSRMStep(step) {
  const maneuver = step.maneuver || {};
  const road = step.name || '';
  if (maneuver.type === 'depart') return road ? 'Start on ' + road : 'Start route';
  if (maneuver.type === 'arrive') return 'Arrive at destination';
  const action = maneuver.type === 'turn' || maneuver.type === 'end of road' ? 'Turn' : capitalize(maneuver.type || 'Continue');
  const direction = maneuver.modifier && maneuver.modifier !== 'straight' ? ' ' + maneuver.modifier : '';
  return action + direction + (road ? ' onto ' + road : '');
}

function arrangeRouteChoices(choices, source) {
  if (!choices.length) return [];
  if (source === 'deflock') return choices.slice(0, 2);
  if (choices.length === 1) return [{ ...choices[0], id: 'privacy', label: 'Keyless route' }];
  const fastest = choices[0];
  if (!choices.every(choice => Number.isFinite(choice.cameraCount))) {
    return [
      { ...fastest, id: 'privacy', label: 'Keyless road route' },
      { ...choices[1], id: 'standard', label: 'Alternative route' },
    ];
  }
  const lowerExposure = choices.reduce((best, item) => {
    const itemCount = Number.isFinite(item.cameraCount) ? item.cameraCount : Infinity;
    const bestCount = Number.isFinite(best.cameraCount) ? best.cameraCount : Infinity;
    if (itemCount < bestCount) return item;
    if (itemCount === bestCount && routeDistance(item.route) < routeDistance(best.route)) return item;
    return best;
  }, choices[0]);
  const other = lowerExposure.id === fastest.id ? choices.find(choice => choice.id !== lowerExposure.id) : fastest;
  return [
    { ...lowerExposure, id: 'privacy', label: 'Fewer known cameras' },
    { ...other, id: 'standard', label: other.label || 'Alternative route' },
  ];
}

async function getCameraIndex() {
  if (cameraIndex) return cameraIndex;
  if (!cameraIndexPromise) {
    cameraIndexPromise = fetch('/api/camera-index').then(async response => {
      const data = await response.json();
      if (!response.ok || !data.countries || typeof data.countries !== 'object') throw new Error(data.error || 'Camera tile sources are unavailable.');
      cameraIndex = data;
      return cameraIndex;
    }).catch(error => { cameraIndexPromise = null; throw error; });
  }
  return cameraIndexPromise;
}

function countriesForPoint(lat, lng, index) {
  const supported = Object.keys(index.countries);
  if (lat > 50 && lng > -130) return supported.includes('ca') ? ['ca'] : supported;
  if (lat < 41.5) return supported.includes('us') ? ['us'] : supported;
  return supported;
}

function tileCoordinates(lat, lng, zoom) {
  const count = 2 ** zoom;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const normalizedLng = ((lng + 180) % 360 + 360) % 360 - 180;
  const xFloat = (normalizedLng + 180) / 360 * count;
  const radians = clampedLat * Math.PI / 180;
  const yFloat = (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * count;
  return { xFloat, yFloat, x: Math.floor(xFloat), y: Math.floor(yFloat), count };
}

function tileKeysNearPoint(lat, lng, zoom, radius, countries) {
  const point = tileCoordinates(lat, lng, zoom);
  const fraction = Math.min(1.25, radius / Math.max(1, 2 * Math.PI * EARTH_RADIUS * Math.max(0.12, Math.cos(lat * Math.PI / 180)) / point.count));
  const cols = [point.x], rows = [point.y];
  const fracX = point.xFloat - point.x, fracY = point.yFloat - point.y;
  if (fracX <= fraction) cols.push(point.x - 1);
  if (1 - fracX <= fraction) cols.push(point.x + 1);
  if (fracY <= fraction) rows.push(point.y - 1);
  if (1 - fracY <= fraction) rows.push(point.y + 1);
  const keys = [];
  for (const country of countries) {
    const source = cameraIndex.countries[country];
    if (!source) continue;
    const z = Math.max(source.minZoom, Math.min(source.maxZoom, zoom));
    const limit = 2 ** z;
    for (const row of rows) for (const col of cols) {
      const y = Math.max(0, Math.min(limit - 1, row));
      const x = ((col % limit) + limit) % limit;
      const key = [country, z, x, y].join('/');
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

function routeCameraTileKeys(route, radius, index) {
  const points = getShape(route);
  const keys = new Set();
  if (!points.length) return [];
  const add = point => {
    for (const key of tileKeysNearPoint(point[0], point[1], CAMERA_ROUTE_ZOOM, radius, countriesForPoint(point[0], point[1], index))) keys.add(key);
  };
  add(points[0]);
  for (let i = 1; i < points.length; i++) {
    const start = points[i - 1], end = points[i];
    const distance = haversineMeters(start, end);
    const midLat = (start[0] + end[0]) / 2;
    const tileGroundMeters = 2 * Math.PI * EARTH_RADIUS * Math.max(0.12, Math.cos(midLat * Math.PI / 180)) / (2 ** CAMERA_ROUTE_ZOOM);
    const steps = Math.max(1, Math.ceil(distance / Math.max(1000, tileGroundMeters / 2)));
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      add([start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t]);
    }
  }
  return Array.from(keys);
}

function visibleMapTileKeys(bounds, zoom, index) {
  const center = bounds.getCenter();
  const countries = countriesForPoint(center.lat, center.lng, index);
  const keys = new Set();
  for (const country of countries) {
    const source = index.countries[country];
    if (!source) continue;
    const z = Math.max(source.minZoom, Math.min(source.maxZoom, zoom));
    const northWest = tileCoordinates(bounds.getNorth(), bounds.getWest(), z);
    const southEast = tileCoordinates(bounds.getSouth(), bounds.getEast(), z);
    for (let y = Math.max(0, northWest.y); y <= Math.min(2 ** z - 1, southEast.y); y++) {
      for (let x = Math.max(0, northWest.x); x <= Math.min(2 ** z - 1, southEast.x); x++) keys.add([country, z, x, y].join('/'));
    }
  }
  return Array.from(keys);
}

async function loadRouteCameraTiles(route, radius) {
  const index = await getCameraIndex();
  let keys = routeCameraTileKeys(route, radius, index);
  let warning = '';
  if (keys.length > MAX_ROUTE_TILES) {
    keys = keys.slice(0, MAX_ROUTE_TILES);
    warning = 'Route crosses more camera tiles than the per-route load limit; coverage is partial';
  }
  const result = await loadCameraTiles(keys);
  if (result.errors) warning = warning || 'Some camera tiles could not be loaded; coverage is partial';
  return { warning, tilesLoaded: result.loaded, updatedAt: latestSourceUpdate(index, keys.map(key => key.split('/')[0])) };
}

async function loadMapArea() {
  if (map.getZoom() < 7) return setStatus('Zoom in to a local area before loading its camera layer.', 'warning');
  areaLoadButton.disabled = true;
  areaLoadButton.textContent = 'Loading camera tiles…';
  try {
    const index = await getCameraIndex();
    const zoom = Math.round(Math.max(9, Math.min(14, map.getZoom())));
    const keys = visibleMapTileKeys(map.getBounds(), zoom, index);
    if (!keys.length) throw new Error('No camera tiles are indexed for this map area yet.');
    if (keys.length > MAX_AREA_TILES) throw new Error('Zoom in further to load a smaller map area.');
    const result = await loadCameraTiles(keys);
    setStatus(cameras.length.toLocaleString() + ' known camera points loaded. Community inventory may be incomplete.', result.errors ? 'warning' : 'success');
    mapCaption.textContent = cameras.length.toLocaleString() + ' camera points · DeFlock Maps / OSM';
  } catch (error) { setStatus(error.message || 'Could not load camera data for this area.', 'error'); }
  finally { areaLoadButton.disabled = false; areaLoadButton.textContent = 'Load cameras for this map area'; }
}

async function loadCameraTiles(keys) {
  const missing = keys.filter(key => !tileCache.has(key));
  let errors = 0;
  for (let offset = 0; offset < missing.length; offset += 8) {
    const batch = missing.slice(offset, offset + 8);
    await Promise.all(batch.map(async key => {
      try {
        const [country, z, x, y] = key.split('/');
        const response = await fetch('/api/camera-tile?' + new URLSearchParams({ country, z, x, y }));
        if (response.status === 204) { tileCache.set(key, []); return; }
        if (!response.ok) throw new Error('Tile request failed');
        const buffer = await response.arrayBuffer();
        tileCache.set(key, buffer.byteLength ? decodeCameraTile(buffer, Number(z), Number(x), Number(y)) : []);
      } catch { errors++; }
    }));
  }
  refreshCameraList();
  return { errors, loaded: keys.length - errors };
}

function decodeCameraTile(buffer, z, x, y) {
  const tile = new VectorTile(new PbfReader(new Uint8Array(buffer)));
  const layer = tile.layers.cameras;
  if (!layer) return [];
  const points = [];
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    const geo = feature.toGeoJSON(x, y, z);
    const geometry = geo.geometry;
    if (!geometry) continue;
    const coords = geometry.type === 'Point' ? [geometry.coordinates] : geometry.type === 'MultiPoint' ? geometry.coordinates : [];
    const p = geo.properties || feature.properties || {};
    for (const coordinate of coords) {
      const lng = Number(coordinate[0]), lat = Number(coordinate[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const tags = { operator: p.operator, brand: p.brand, direction: p.direction, directions: p.directions, surveillanceZone: p.surveillanceZone, mountType: p.mountType };
      points.push({ id: 'osm-' + String(p.osmId ?? feature.id ?? lat + ',' + lng), lat, lng, name: p.brand || p.operator || 'ALPR location', tags, source: 'DeFlock Maps / OpenStreetMap' });
    }
  }
  return points;
}

function latestSourceUpdate(index, countries) {
  const dates = countries.map(country => index.countries[country]?.updatedAt).filter(Boolean);
  return dates.sort((a, b) => new Date(b) - new Date(a))[0] || '';
}

function refreshCameraList() {
  const unique = new Map(importedCameras.map(camera => [camera.id, camera]));
  for (const tile of tileCache.values()) for (const camera of tile) if (!unique.has(camera.id)) unique.set(camera.id, camera);
  cameras = Array.from(unique.values());
  cameraCount.textContent = cameras.length.toLocaleString() + ' loaded';
  renderCameraLayer();
}

function renderCameraLayer() {
  cameraLayer.clearLayers();
  if (!cameraToggle.checked || !cameras.length) return;
  const bounds = map.getBounds().pad(0.02);
  let visible = cameras.filter(camera => bounds.contains([camera.lat, camera.lng]));
  if (visible.length > MAX_VISIBLE_MARKERS) {
    const center = map.getCenter();
    visible = visible.sort((a, b) => distanceSquared(a, center) - distanceSquared(b, center)).slice(0, MAX_VISIBLE_MARKERS);
    mapCaption.textContent = 'Showing ' + MAX_VISIBLE_MARKERS.toLocaleString() + ' of ' + cameras.length.toLocaleString() + ' camera points';
  }
  for (const camera of visible) {
    const marker = L.circleMarker([camera.lat, camera.lng], { renderer: cameraRenderer, radius: 6, color: '#fff', weight: 1.5, fillColor: '#e9655b', fillOpacity: 0.95 });
    const popup = document.createElement('div'); popup.className = 'camera-popup';
    const title = document.createElement('strong'); title.textContent = camera.name || 'ALPR location';
    const detail = document.createElement('span'); detail.textContent = ((camera.tags && camera.tags.operator) ? 'Operator: ' + camera.tags.operator + ' · ' : '') + (camera.source || 'DeFlock Maps / OpenStreetMap') + ' · ' + camera.lat.toFixed(5) + ', ' + camera.lng.toFixed(5);
    popup.append(title, detail); marker.bindPopup(popup); marker.addTo(cameraLayer);
  }
}

function findNearbyCameras(route, radius) {
  const points = getShape(route);
  if (!points.length || !cameras.length) return [];
  const padLat = radius / 111320;
  let south = 90, north = -90, west = 180, east = -180;
  for (const point of points) { south = Math.min(south, point[0]); north = Math.max(north, point[0]); west = Math.min(west, point[1]); east = Math.max(east, point[1]); }
  const cos = Math.max(0.15, Math.cos(((south + north) / 2) * Math.PI / 180));
  const padLng = padLat / cos;
  const candidates = cameras.filter(camera => camera.lat >= south - padLat && camera.lat <= north + padLat && camera.lng >= west - padLng && camera.lng <= east + padLng);
  return candidates.filter(camera => {
    if (points.length === 1) return pointToSegmentMeters(camera, points[0], points[0]) <= radius;
    for (let i = 0; i < points.length - 1; i++) if (pointToSegmentMeters(camera, points[i], points[i + 1]) <= radius) return true;
    return false;
  });
}

function getShape(route) {
  const geometry = route.geometry;
  if (geometry && Array.isArray(geometry.coordinates)) return geometry.coordinates.map(point => [Number(point[1]), Number(point[0])]).filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (Array.isArray(geometry)) return geometry.map(point => [Number(point[0]), Number(point[1])]).filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
  const raw = (route.shape && route.shape.shapePoints) || route.shapePoints || [];
  const points = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const lat = Number(raw[i]), lng = Number(raw[i + 1]);
    if (Number.isFinite(lat) && Number.isFinite(lng)) points.push([lat, lng]);
  }
  return points;
}

function pointToSegmentMeters(point, start, end) {
  const cos = Math.cos(point.lat * Math.PI / 180);
  const project = value => ({ x: (value[1] - point.lng) * Math.PI / 180 * EARTH_RADIUS * cos, y: (value[0] - point.lat) * Math.PI / 180 * EARTH_RADIUS });
  const a = project(start), b = project(end), dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
  const t = length2 ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / length2)) : 0;
  return Math.hypot(a.x + t * dx, a.y + t * dy);
}

function haversineMeters(start, end) {
  const lat1 = start[0] * Math.PI / 180, lat2 = end[0] * Math.PI / 180;
  const dLat = lat2 - lat1, dLng = (end[1] - start[1]) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function routeDistance(route) { return Number(route.distanceMeters ?? route.distance ?? 0); }
function routeDuration(route) { return Number(route.durationSeconds ?? route.duration ?? 0); }
function distanceSquared(point, center) { return (point.lat - center.lat) ** 2 + (point.lng - center.lng) ** 2; }
function capitalize(value) { return value ? value[0].toUpperCase() + value.slice(1) : ''; }
function formatMeters(meters) { return meters >= 1000 ? (meters / 1000).toFixed(meters >= 10000 ? 0 : 1) + ' km' : Math.round(meters) + ' m'; }
function formatDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + ' min';
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return remainder ? hours + ' hr ' + remainder + ' min' : hours + ' hr';
}
function formatSourceDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function renderRouteChoices(origin, destination, source) {
  for (const line of routeLayers.values()) map.removeLayer(line);
  routeLayers.clear();
  if (routeStartMarker) map.removeLayer(routeStartMarker);
  if (routeEndMarker) map.removeLayer(routeEndMarker);
  const privacy = routeOptions[0];
  const standard = routeOptions[1] || null;
  const privacyLabel = document.querySelector('#privacy-choice-label');
  const standardLabel = document.querySelector('#standard-choice-label');
  privacyChoiceButton.hidden = !privacy;
  standardChoiceButton.hidden = !standard;
  privacyLabel.textContent = privacy ? privacy.label : '';
  standardLabel.textContent = standard ? standard.label : '';
  fillRouteChoiceCard(privacyChoiceButton, privacy, standard);
  fillRouteChoiceCard(standardChoiceButton, standard, standard);
  routeStartMarker = L.circleMarker([origin.lat, origin.lng], { radius: 7, color: '#fff', weight: 3, fillColor: '#68882c', fillOpacity: 1 }).addTo(map).bindTooltip('Route start', { direction: 'top', offset: [0, -8] });
  routeEndMarker = L.circleMarker([destination.lat, destination.lng], { radius: 7, color: '#fff', weight: 3, fillColor: '#e06759', fillOpacity: 1 }).addTo(map).bindTooltip(destination.label, { direction: 'top', offset: [0, -8] });
  for (const choice of routeOptions) {
    const selected = choice.id === selectedRouteId;
    const line = L.polyline(getShape(choice.route), { color: selected ? '#537cde' : '#8d9690', weight: selected ? 5 : 3, opacity: selected ? 0.95 : 0.65, dashArray: selected ? null : '5 7', lineCap: 'round', lineJoin: 'round' }).addTo(map);
    routeLayers.set(choice.id, line);
  }
  updateSelectedRoute();
  const selected = routeOptions.find(choice => choice.id === selectedRouteId) || privacy;
  const shape = getShape(selected.route);
  if (shape.length) map.fitBounds(L.latLngBounds(shape).pad(0.13), { maxZoom: 15 });
  cameraLayer.bringToFront();
  trailLine.bringToFront();
  if (trailMarker) trailMarker.bringToFront();
  mapCaption.textContent = cameras.length.toLocaleString() + ' camera points loaded · origin not retained';
}

function fillRouteChoiceCard(button, choice, standard) {
  if (!choice) return;
  const distance = routeDistance(choice.route);
  const duration = routeDuration(choice.route);
  const cameraCountValue = Number.isFinite(choice.cameraCount) ? choice.cameraCount : 0;
  const baseline = standard ? routeDistance(standard.route) : distance;
  const delta = baseline > 0 ? Math.round((distance / baseline - 1) * 100) : 0;
  button.querySelector('strong').textContent = formatMeters(distance) + ' · ' + formatDuration(duration);
  let exposure = Number.isFinite(choice.cameraCount) ? cameraCountValue + ' known ALPR' + (cameraCountValue === 1 ? '' : 's') : 'Exposure unavailable';
  if (delta > 0 && choice.id === 'privacy') exposure += ' · +' + delta + '% distance';
  button.querySelector('small').textContent = exposure;
}

function selectRoute(id) {
  if (!routeOptions.some(choice => choice.id === id)) return;
  selectedRouteId = id;
  updateSelectedRoute();
}

function updateSelectedRoute() {
  for (const choice of routeOptions) {
    const selected = choice.id === selectedRouteId;
    const line = routeLayers.get(choice.id);
    if (line) line.setStyle({ color: selected ? '#537cde' : '#8d9690', weight: selected ? 5 : 3, opacity: selected ? 0.95 : 0.65, dashArray: selected ? null : '5 7' });
  }
  privacyChoiceButton.classList.toggle('active', selectedRouteId === (routeOptions[0] && routeOptions[0].id));
  standardChoiceButton.classList.toggle('active', selectedRouteId === (routeOptions[1] && routeOptions[1].id));
  const choice = routeOptions.find(item => item.id === selectedRouteId);
  if (!choice) return;
  routeSummary.textContent = choice.label + ' · ' + formatMeters(routeDistance(choice.route)) + ' · ' + formatDuration(routeDuration(choice.route));
  renderManeuvers(choice.route);
}

function renderManeuvers(route) {
  stepsList.replaceChildren();
  let maneuvers = route.maneuvers || [];
  if (!maneuvers.length && route.legs) maneuvers = route.legs.flatMap(leg => (leg.steps || []).map(step => ({ instruction: describeOSRMStep(step), length: step.distance, time: step.duration })));
  maneuvers.forEach((maneuver, index) => {
    const li = document.createElement('li'), number = document.createElement('span'), narrative = document.createElement('span'), distance = document.createElement('span');
    number.className = 'step-num'; number.textContent = String(index + 1).padStart(2, '0');
    narrative.textContent = maneuver.instruction || maneuver.narrative || 'Continue along route';
    distance.className = 'step-distance';
    const meters = Number(maneuver.length ?? maneuver.distance ?? 0);
    distance.textContent = meters ? formatMeters(meters) : '';
    li.append(number, narrative, distance); stepsList.append(li);
  });
}

function toggleGpsTrail() {
  if (trailWatchId !== null) return stopGpsTrail();
  if (!navigator.geolocation) { trailStatus.textContent = 'This browser does not support GPS tracking.'; return; }
  trailStartedAt = Date.now();
  trailWatchId = navigator.geolocation.watchPosition(onTrailPosition, onTrailError, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  trailButton.textContent = 'Stop GPS trail';
  trailButton.classList.add('active');
  trailStatus.textContent = 'Waiting for an accurate GPS fix. Trail is stored only in this tab.';
  trailTimerId = setInterval(updateTrailStats, 1000);
  updateTrailStats();
}

function onTrailPosition(position) {
  const point = { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy, timestamp: position.timestamp || Date.now() };
  latestFix = point;
  if (point.accuracy > 100) {
    trailStatus.textContent = 'GPS accuracy is about ' + Math.round(point.accuracy) + ' m; waiting for a clearer fix.';
    return;
  }
  const last = trailPoints[trailPoints.length - 1];
  if (last) {
    const moved = haversineMeters([last.lat, last.lng], [point.lat, point.lng]);
    const elapsed = (point.timestamp - last.timestamp) / 1000;
    if (moved < 5 || (elapsed < 2 && moved > 100)) return;
    trailDistance += moved;
  } else {
    map.setView([point.lat, point.lng], Math.max(14, map.getZoom()));
  }
  trailPoints.push(point);
  if (trailPoints.length > 10000) trailPoints.shift();
  trailLine.setLatLngs(trailPoints.map(item => [item.lat, item.lng]));
  if (!trailMarker) trailMarker = L.circleMarker([point.lat, point.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#ee9654', fillOpacity: 1 }).addTo(map);
  else trailMarker.setLatLng([point.lat, point.lng]);
  trailLine.bringToFront(); trailMarker.bringToFront();
  trailStatus.textContent = 'Recording · ' + trailPoints.length.toLocaleString() + ' points · accuracy ' + Math.round(point.accuracy) + ' m. Not uploaded.';
  updateTrailStats();
}

function onTrailError(error) {
  trailStatus.textContent = error.code === 1 ? 'GPS permission was declined.' : 'GPS signal was lost; trail is paused until a fix returns.';
  if (error.code === 1) stopGpsTrail();
}

function stopGpsTrail() {
  if (trailWatchId !== null) navigator.geolocation.clearWatch(trailWatchId);
  trailWatchId = null;
  if (trailTimerId !== null) clearInterval(trailTimerId);
  trailTimerId = null;
  trailButton.textContent = 'Resume GPS trail';
  trailButton.classList.remove('active');
  if (trailPoints.length) trailStatus.textContent = 'Trail paused · stored only in this tab. Clear it to remove the recorded line.';
}

function clearGpsTrail() {
  if (trailWatchId !== null) stopGpsTrail();
  trailPoints = []; trailDistance = 0; trailStartedAt = null;
  trailLine.setLatLngs([]);
  if (trailMarker) { map.removeLayer(trailMarker); trailMarker = null; }
  trailButton.textContent = 'Start GPS trail';
  trailStatus.textContent = 'Trail cleared. New points stay in this tab only.';
  updateTrailStats();
}

function updateTrailStats() {
  trailDistanceOutput.textContent = formatMeters(trailDistance);
  const seconds = trailStartedAt ? Math.floor((Date.now() - trailStartedAt) / 1000) : 0;
  const minutes = Math.floor(seconds / 60);
  trailElapsedOutput.textContent = String(minutes).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
}

function importCameraFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  file.text().then(text => {
    const imported = file.name.toLowerCase().endsWith('.csv') ? parseCsv(text) : parseGeoJson(JSON.parse(text));
    if (!imported.length) throw new Error('No valid coordinate points were found.');
    if (imported.length > MAX_IMPORT_POINTS) throw new Error('This file has more than ' + MAX_IMPORT_POINTS.toLocaleString() + ' points.');
    importedCameras = imported.map((item, index) => ({ ...item, id: 'file-' + String(item.id ?? index), source: file.name }));
    uploadLabel.textContent = file.name;
    refreshCameraList();
    setStatus(imported.length.toLocaleString() + ' points from ' + file.name + ' loaded locally; the file was not uploaded.', 'success');
  }).catch(error => setStatus(error.message || 'Could not read that camera-location file.', 'error')).finally(() => { cameraFile.value = ''; });
}

function parseGeoJson(data) {
  const found = [];
  const add = feature => {
    if (!feature || !feature.geometry) return;
    const properties = feature.properties || {};
    const coords = feature.geometry.type === 'Point' ? [feature.geometry.coordinates] : feature.geometry.type === 'MultiPoint' ? feature.geometry.coordinates : [];
    for (const coordinate of coords) {
      const lng = Number(coordinate && coordinate[0]), lat = Number(coordinate && coordinate[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) found.push({ lat, lng, name: properties.name || properties.brand || properties.operator || 'Known ALPR', id: properties.id, tags: properties, source: 'Imported data' });
    }
  };
  if (data.type === 'FeatureCollection') (data.features || []).forEach(add);
  else if (data.type === 'Feature') add(data);
  else if (data.type === 'Point') add({ geometry: data, properties: {} });
  else throw new Error('GeoJSON must contain Point or MultiPoint features.');
  return found;
}

function parseCsv(text) {
  const rows = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  if (rows.length < 2) throw new Error('CSV needs headers and at least one location.');
  const split = line => {
    const cells = []; let cell = '', quote = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"' && line[i + 1] === '"' && quote) { cell += '"'; i++; }
      else if (char === '"') quote = !quote;
      else if (char === ',' && !quote) { cells.push(cell.trim()); cell = ''; }
      else cell += char;
    }
    cells.push(cell.trim()); return cells;
  };
  const headers = split(rows[0]).map(value => value.toLowerCase().replace(/[ _-]/g, ''));
  const latIndex = headers.findIndex(value => ['lat', 'latitude', 'y'].includes(value));
  const lngIndex = headers.findIndex(value => ['lng', 'lon', 'long', 'longitude', 'x'].includes(value));
  if (latIndex < 0 || lngIndex < 0) throw new Error('CSV needs latitude and longitude columns.');
  const nameIndex = headers.findIndex(value => ['name', 'title', 'brand', 'operator'].includes(value));
  return rows.slice(1).map((line, index) => {
    const cells = split(line), lat = Number(cells[latIndex]), lng = Number(cells[lngIndex]);
    return { lat, lng, id: index, name: nameIndex >= 0 ? cells[nameIndex] : 'Known ALPR', source: 'Imported data' };
  }).filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng) && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180);
}

function clearRoute() {
  for (const line of routeLayers.values()) map.removeLayer(line);
  routeLayers.clear();
  if (routeStartMarker) map.removeLayer(routeStartMarker);
  if (routeEndMarker) map.removeLayer(routeEndMarker);
  routeStartMarker = routeEndMarker = null;
  routeOptions = [];
  selectedRouteId = null;
  resultBox.hidden = true;
  mapCaption.textContent = cameras.length ? cameras.length.toLocaleString() + ' camera points loaded' : 'Open map · no camera tiles loaded';
  setStatus('Route options cleared.');
}
