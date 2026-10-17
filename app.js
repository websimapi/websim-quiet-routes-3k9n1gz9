import { VectorTile } from 'https://esm.sh/@mapbox/vector-tile@3.0.0?bundle';
import { PbfReader } from 'https://esm.sh/pbf@5.1.2?bundle';

const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([39.5, -98.35], 4);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);

const keyInput = document.querySelector('#api-key');
const destinationInput = document.querySelector('#destination');
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

let cameras = [];
let importedCameras = [];
let cameraIndexPromise = null;
let cameraIndex = null;
const tileCache = new Map();
const cameraLayer = L.layerGroup().addTo(map);
const cameraRenderer = L.canvas({ padding: 0.4 });
let routeLayer = null;
let originMarker = null;
let destinationMarker = null;
const MAX_IMPORT_POINTS = 20000;
const MAX_VISIBLE_MARKERS = 3500;
const MAX_ROUTE_TILES = 300;
const MAX_AREA_TILES = 100;
const MAX_ROUTE_AVOID_PASSES = 4;
const EARTH_RADIUS = 6371000;
const CAMERA_ROUTE_ZOOM = 10;

// MapQuest documents road-link avoidance, not camera avoidance. This bridge
// identifies camera-adjacent links from each returned shape and retries them.
document.querySelector('#key-form').addEventListener('submit', event => event.preventDefault());
bufferInput.addEventListener('input', () => { bufferOutput.value = bufferInput.value + ' m'; });
cameraToggle.addEventListener('change', renderCameraLayer);
cameraFile.addEventListener('change', importCameraFile);
routeButton.addEventListener('click', startRoute);
areaLoadButton.addEventListener('click', loadMapArea);
clearButton.addEventListener('click', clearRoute);
destinationInput.addEventListener('keydown', event => { if (event.key === 'Enter') startRoute(); });
map.on('moveend zoomend', renderCameraLayer);

function setStatus(message, kind = '') {
  statusBox.textContent = message;
  statusBox.className = 'status' + (kind ? ' ' + kind : '');
}

function readPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser does not provide location access.'));
    navigator.geolocation.getCurrentPosition(
      position => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      error => reject(new Error(error.code === 1 ? 'Location permission was declined. Allow location access, then try again.' : error.code === 2 ? 'Your location could not be determined. Try again from a place with a clearer GPS signal.' : 'Location took too long. Try again.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}

async function startRoute() {
  const key = keyInput.value.trim();
  const destination = destinationInput.value.trim();
  if (!key) return setStatus('Enter your MapQuest API key to request directions.', 'error');
  if (!destination) return setStatus('Enter a destination first.', 'error');

  routeButton.disabled = true;
  routeButton.querySelector('span:first-child').textContent = 'Finding your location…';
  resultBox.hidden = true;
  setStatus('Waiting for location permission. Your browser will ask before sharing GPS.');
  try {
    const origin = await readPosition();
    mapCaption.textContent = 'Location acquired · calculating route';
    setStatus('Requesting an initial MapQuest route…');
    const initialRoute = await requestMapQuestRoute(key, origin, destination, []);
    setStatus('Loading current camera tiles along the route and checking road links…');
    const outcome = await calculateAvoidingRoute(key, origin, destination, Number(bufferInput.value), initialRoute);
    renderRoute(outcome.route, origin, destination);

    const remaining = findNearbyCameras(outcome.route, Number(bufferInput.value));
    const summaryParts = [];
    if (outcome.initialNearby > 0) summaryParts.push(outcome.initialNearby + ' known camera point' + (outcome.initialNearby === 1 ? '' : 's') + ' near the first route');
    if (outcome.linksRequested > 0) summaryParts.push('requested avoidance for ' + outcome.linksRequested + ' road link' + (outcome.linksRequested === 1 ? '' : 's'));
    if (!outcome.cameraDataLoaded) summaryParts.push('no camera tiles were available');
    if (remaining.length) summaryParts.push(remaining.length + ' known point' + (remaining.length === 1 ? '' : 's') + ' remain within ' + bufferInput.value + ' m');
    else if (outcome.cameraDataLoaded) summaryParts.push('no loaded points remain within ' + bufferInput.value + ' m');
    if (outcome.warning) summaryParts.push(outcome.warning);
    if (outcome.updatedAt) summaryParts.push('camera tiles last updated ' + formatSourceDate(outcome.updatedAt));
    summaryParts.push('inventory and avoidance are best-effort, not guaranteed');
    setStatus(summaryParts.join('. ') + '.', remaining.length || outcome.warning ? 'warning' : 'success');
    resultBox.hidden = false;
    mapCaption.textContent = cameras.length.toLocaleString() + ' camera point' + (cameras.length === 1 ? '' : 's') + ' loaded · origin held in this tab';
    renderCameraLayer();
  } catch (error) {
    setStatus(error.message || 'Could not calculate this route. Check the API key and connection.', 'error');
    mapCaption.textContent = 'No location retained';
  } finally {
    routeButton.disabled = false;
    routeButton.querySelector('span:first-child').textContent = 'Route from my location';
  }
}

async function calculateAvoidingRoute(key, origin, destination, radius, initialRoute) {
  let route = initialRoute;
  let warning = '';
  const blockedLinks = new Set();
  let initialNearby = 0;
  let initialCountSet = false;
  let cameraDataLoaded = cameras.length > 0;
  let updatedAt = '';

  for (let pass = 0; pass < MAX_ROUTE_AVOID_PASSES; pass++) {
    try {
      const loaded = await loadRouteCameraTiles(route, radius);
      cameraDataLoaded = cameraDataLoaded || loaded.tilesLoaded > 0;
      updatedAt = loaded.updatedAt || updatedAt;
      if (loaded.warning) warning = loaded.warning;
    } catch (error) {
      warning = error.message || 'Camera data could not be loaded';
      initialNearby = findNearbyCameras(route, radius).length;
      break;
    }

    const nearby = findNearbyCameras(route, radius);
    if (!initialCountSet) { initialNearby = nearby.length; initialCountSet = true; }
    const newLinks = new Set();
    for (const camera of nearby) {
      const links = linksNearCamera(route, camera, radius);
      if (!links.length) continue;
      for (const linkId of links) if (!blockedLinks.has(linkId)) newLinks.add(linkId);
    }
    if (!newLinks.size) break;
    for (const linkId of newLinks) {
      if (blockedLinks.size >= 100) break;
      blockedLinks.add(linkId);
    }
    try {
      route = await requestMapQuestRoute(key, origin, destination, Array.from(blockedLinks));
    } catch {
      warning = 'MapQuest could not find a route with all requested road links avoided; showing the last successful route';
      break;
    }
    if (pass === MAX_ROUTE_AVOID_PASSES - 1) warning = 'Reached the reroute request limit';
  }

  return { route, warning, initialNearby, linksRequested: blockedLinks.size, cameraDataLoaded, updatedAt };
}

async function requestMapQuestRoute(key, origin, destination, avoidIds) {
  const params = new URLSearchParams({
    key,
    from: origin.lat + ',' + origin.lng,
    to: destination,
    routeType: 'fastest',
    unit: 'k',
    fullShape: 'true',
    shapeFormat: 'raw',
    maxLinkId: '10',
    narrativeType: 'text',
    outFormat: 'json'
  });
  if (avoidIds.length) params.set('mustAvoidLinkIds', avoidIds.join(','));
  let response;
  try { response = await fetch('https://www.mapquestapi.com/directions/v2/route?' + params.toString()); }
  catch { throw new Error('Could not reach MapQuest. Check your connection and try again.'); }
  let data;
  try { data = await response.json(); }
  catch { throw new Error('MapQuest returned an unreadable response.'); }
  if (!response.ok) throw new Error('MapQuest request failed (' + response.status + ').');
  if ((data.info && data.info.statuscode !== 0) || !data.route) {
    const detail = data.info && data.info.messages && data.info.messages[0];
    throw new Error((detail || 'No route was returned.') + ' Check your API key and destination.');
  }
  return data.route;
}

async function getCameraIndex() {
  if (cameraIndex) return cameraIndex;
  if (!cameraIndexPromise) {
    cameraIndexPromise = fetch('/api/camera-index').then(async response => {
      const data = await response.json();
      if (!response.ok || !data.countries || typeof data.countries !== 'object') {
        throw new Error(data.error || 'Camera tile sources are unavailable.');
      }
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
  return {
    tilesLoaded: result.loaded,
    warning,
    updatedAt: latestSourceUpdate(index, keys.map(key => key.split('/')[0])),
  };
}

async function loadMapArea() {
  if (map.getZoom() < 7) {
    setStatus('Zoom in to a local area before loading its camera layer.', 'warning');
    return;
  }
  areaLoadButton.disabled = true;
  areaLoadButton.textContent = 'Loading camera tiles…';
  try {
    const index = await getCameraIndex();
    const zoom = Math.round(Math.max(9, Math.min(14, map.getZoom())));
    let keys = visibleMapTileKeys(map.getBounds(), zoom, index);
    if (!keys.length) throw new Error('No camera tiles are indexed for this map area yet.');
    if (keys.length > MAX_AREA_TILES) throw new Error('Zoom in further to load a smaller map area.');
    const result = await loadCameraTiles(keys);
    const updatedAt = latestSourceUpdate(index, keys.map(key => key.split('/')[0]));
    const freshness = updatedAt ? ' Tile feed updated ' + formatSourceDate(updatedAt) + '.' : '';
    setStatus(cameras.length.toLocaleString() + ' known camera points loaded from hourly community tiles.' + freshness + ' Inventory may be incomplete.', result.errors ? 'warning' : 'success');
    mapCaption.textContent = cameras.length.toLocaleString() + ' camera point' + (cameras.length === 1 ? '' : 's') + ' loaded · DeFlock map / OSM';
  } catch (error) { setStatus(error.message || 'Could not load camera data for this area.', 'error'); }
  finally { areaLoadButton.disabled = false; areaLoadButton.textContent = 'Load cameras for this map area'; }
}

async function loadCameraTiles(keys) {
  const missing = keys.filter(key => !tileCache.has(key));
  let errors = 0, loaded = 0;
  for (let offset = 0; offset < missing.length; offset += 8) {
    const batch = missing.slice(offset, offset + 8);
    const outcomes = await Promise.all(batch.map(async key => {
      try {
        const [country, z, x, y] = key.split('/');
        const response = await fetch('/api/camera-tile?' + new URLSearchParams({ country, z, x, y }));
        if (response.status === 204) { tileCache.set(key, []); loaded++; return; }
        if (!response.ok) throw new Error('Tile request failed');
        const buffer = await response.arrayBuffer();
        const decoded = buffer.byteLength ? decodeCameraTile(buffer, Number(z), Number(x), Number(y)) : [];
        tileCache.set(key, decoded);
        loaded++;
      } catch { errors++; }
    }));
  }
  refreshCameraList();
  return { errors, loaded };
}

function decodeCameraTile(buffer, z, x, y) {
  const tile = new VectorTile(new PbfReader(new Uint8Array(buffer)));
  const layer = tile.layers.cameras;
  if (!layer) return [];
  const decoded = [];
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    const geo = feature.toGeoJSON(x, y, z);
    const geometry = geo.geometry;
    if (!geometry) continue;
    const coordinates = geometry.type === 'Point' ? [geometry.coordinates] : geometry.type === 'MultiPoint' ? geometry.coordinates : [];
    const properties = geo.properties || feature.properties || {};
    for (const coordinate of coordinates) {
      const lng = Number(coordinate[0]), lat = Number(coordinate[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const osmId = properties.osmId ?? feature.id ?? (lat.toFixed(6) + ',' + lng.toFixed(6));
      const tags = {
        operator: properties.operator,
        brand: properties.brand,
        direction: properties.direction,
        directions: properties.directions,
        surveillanceZone: properties.surveillanceZone,
        mountType: properties.mountType,
      };
      decoded.push({
        id: 'osm-' + String(osmId), lat, lng,
        name: properties.brand || properties.operator || 'Crowdsourced ALPR location',
        tags, source: 'DeFlock map / OpenStreetMap'
      });
    }
  }
  return decoded;
}

function latestSourceUpdate(index, countries) {
  const dates = countries.map(country => index.countries[country]?.updatedAt).filter(Boolean);
  if (!dates.length) return '';
  return dates.sort((a, b) => new Date(b) - new Date(a))[0];
}

function formatSourceDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function refreshCameraList() {
  const all = importedCameras.slice();
  for (const tile of tileCache.values()) all.push(...tile);
  const unique = new Map();
  for (const camera of all) {
    if (!Number.isFinite(camera.lat) || !Number.isFinite(camera.lng)) continue;
    const key = camera.id || camera.lat.toFixed(6) + ',' + camera.lng.toFixed(6);
    if (!unique.has(key)) unique.set(key, camera);
  }
  cameras = Array.from(unique.values());
  cameraCount.textContent = cameras.length.toLocaleString() + ' loaded';
  renderCameraLayer();
}

function linksNearCamera(route, camera, radius) {
  const points = getShape(route);
  if (points.length < 2) return [];
  let closestDistance = Infinity, closestSegment = -1;
  for (let i = 0; i < points.length - 1; i++) {
    const distance = pointToSegmentMeters(camera, points[i], points[i + 1]);
    if (distance < closestDistance) { closestDistance = distance; closestSegment = i; }
  }
  if (closestDistance > radius || closestSegment < 0) return [];
  const starts = (route.shape && route.shape.maneuverIndexes) || route.maneuverIndexes || [];
  let maneuverIndex = -1;
  for (let i = 0; i < starts.length; i++) if (starts[i] <= closestSegment) maneuverIndex = i;
  const maneuver = (route.legs || []).flatMap(leg => leg.maneuvers || [])[maneuverIndex];
  return (maneuver && maneuver.linkIds || []).map(String).filter(id => /^\d+$/.test(id));
}

function getShape(route) {
  const raw = (route.shape && route.shape.shapePoints) || route.shapePoints || [];
  const points = [];
  if (Array.isArray(raw) && raw.length && typeof raw[0] === 'object') {
    for (const point of raw) {
      const lat = Number(point.lat ?? point.latitude), lng = Number(point.lng ?? point.lon ?? point.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) points.push([lat, lng]);
    }
  } else {
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const lat = Number(raw[i]), lng = Number(raw[i + 1]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) points.push([lat, lng]);
    }
  }
  return points;
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

async function importCameraFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const imported = file.name.toLowerCase().endsWith('.csv') ? parseCsv(text) : parseGeoJson(JSON.parse(text));
    if (!imported.length) throw new Error('No valid coordinate points were found.');
    if (imported.length > MAX_IMPORT_POINTS) throw new Error('This file has more than ' + MAX_IMPORT_POINTS.toLocaleString() + ' points.');
    importedCameras = imported.map((item, index) => ({ ...item, id: 'file-' + String(item.id ?? index), source: file.name }));
    uploadLabel.textContent = file.name;
    refreshCameraList();
    setStatus(imported.length.toLocaleString() + ' points from ' + file.name + ' loaded locally; the file was not uploaded.', 'success');
  } catch (error) { setStatus(error.message || 'Could not read that camera-location file.', 'error'); }
  finally { cameraFile.value = ''; }
}

function parseGeoJson(data) {
  const found = [];
  const addFeature = feature => {
    if (!feature || !feature.geometry) return;
    const properties = feature.properties || {};
    const name = properties.name || properties.title || properties.operator || properties.type || 'Known camera location';
    const addPoint = coordinates => {
      const lng = Number(coordinates && coordinates[0]), lat = Number(coordinates && coordinates[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) found.push({ lat, lng, name, id: properties.id });
    };
    if (feature.geometry.type === 'Point') addPoint(feature.geometry.coordinates);
    if (feature.geometry.type === 'MultiPoint') feature.geometry.coordinates.forEach(addPoint);
  };
  if (data.type === 'FeatureCollection') (data.features || []).forEach(addFeature);
  else if (data.type === 'Feature') addFeature(data);
  else if (data.type === 'Point') addFeature({ geometry: data, properties: {} });
  else throw new Error('GeoJSON must be a Point, MultiPoint, Feature, or FeatureCollection.');
  return found;
}

function parseCsv(text) {
  const rows = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  if (rows.length < 2) throw new Error('CSV needs a header row and at least one location.');
  const splitRow = line => {
    const cells = []; let cell = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"' && line[i + 1] === '"' && quoted) { cell += '"'; i++; }
      else if (char === '"') quoted = !quoted;
      else if (char === ',' && !quoted) { cells.push(cell.trim()); cell = ''; }
      else cell += char;
    }
    cells.push(cell.trim()); return cells;
  };
  const headers = splitRow(rows[0]).map(value => value.toLowerCase().replace(/[ _-]/g, ''));
  const latIndex = headers.findIndex(value => ['lat', 'latitude', 'y'].includes(value));
  const lngIndex = headers.findIndex(value => ['lng', 'lon', 'long', 'longitude', 'x'].includes(value));
  if (latIndex < 0 || lngIndex < 0) throw new Error('CSV needs latitude and longitude columns.');
  const nameIndex = headers.findIndex(value => ['name', 'title', 'operator', 'type', 'location'].includes(value));
  return rows.slice(1).map(line => {
    const cells = splitRow(line), lat = Number(cells[latIndex]), lng = Number(cells[lngIndex]);
    return { lat, lng, name: nameIndex >= 0 && cells[nameIndex] ? cells[nameIndex] : 'Known camera location' };
  }).filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng) && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180);
}

function renderCameraLayer() {
  cameraLayer.clearLayers();
  if (!cameraToggle.checked || !cameras.length) return;
  const bounds = map.getBounds().pad(0.02);
  let visible = cameras.filter(camera => bounds.contains([camera.lat, camera.lng]));
  if (visible.length > MAX_VISIBLE_MARKERS) {
    const center = map.getCenter();
    visible = visible.sort((a, b) => distanceSquared(a, center) - distanceSquared(b, center)).slice(0, MAX_VISIBLE_MARKERS);
    mapCaption.textContent = 'Showing ' + MAX_VISIBLE_MARKERS.toLocaleString() + ' nearest of ' + cameras.length.toLocaleString() + ' loaded camera points';
  }
  for (const camera of visible) {
    const marker = L.circleMarker([camera.lat, camera.lng], { renderer: cameraRenderer, radius: 6, color: '#fff', weight: 1.5, fillColor: '#e9655b', fillOpacity: 0.95 });
    const popup = document.createElement('div'); popup.className = 'camera-popup';
    const title = document.createElement('strong'); title.textContent = camera.name || 'Known camera location';
    const source = document.createElement('span'); source.textContent = ((camera.tags && camera.tags.operator) ? 'Operator: ' + camera.tags.operator + ' · ' : '') + (camera.source || 'DeFlock map / OpenStreetMap') + ' · ' + camera.lat.toFixed(5) + ', ' + camera.lng.toFixed(5);
    popup.append(title, source); marker.bindPopup(popup); marker.addTo(cameraLayer);
  }
}

function distanceSquared(point, center) { return (point.lat - center.lat) ** 2 + (point.lng - center.lng) ** 2; }

function renderRoute(route, origin, destinationText) {
  const points = getShape(route);
  if (!points.length) throw new Error('MapQuest returned directions without route geometry.');
  if (routeLayer) map.removeLayer(routeLayer);
  if (originMarker) map.removeLayer(originMarker);
  if (destinationMarker) map.removeLayer(destinationMarker);
  routeLayer = L.polyline(points, { color: '#537cde', weight: 5, opacity: 0.9, lineCap: 'round', lineJoin: 'round' }).addTo(map);
  originMarker = L.circleMarker([origin.lat, origin.lng], { radius: 7, color: '#fff', weight: 3, fillColor: '#68882c', fillOpacity: 1 }).addTo(map).bindTooltip('Your location', { direction: 'top', offset: [0, -8] });
  const destinationPoint = route.locations && route.locations.length && route.locations[route.locations.length - 1].latLng;
  if (destinationPoint && Number.isFinite(destinationPoint.lat) && Number.isFinite(destinationPoint.lng)) {
    destinationMarker = L.circleMarker([destinationPoint.lat, destinationPoint.lng], { radius: 7, color: '#fff', weight: 3, fillColor: '#e06759', fillOpacity: 1 }).addTo(map).bindTooltip(destinationText, { direction: 'top', offset: [0, -8] });
  }
  map.fitBounds(routeLayer.getBounds().pad(0.13), { maxZoom: 15 });
  const km = Number(route.distance || 0), minutes = Math.round(Number(route.time || 0) / 60);
  routeSummary.textContent = (km < 10 ? km.toFixed(1) : Math.round(km)) + ' km · ' + formatDuration(minutes);
  stepsList.replaceChildren();
  (route.legs || []).flatMap(leg => leg.maneuvers || []).forEach((maneuver, index) => {
    const li = document.createElement('li'), number = document.createElement('span'), narrative = document.createElement('span'), distance = document.createElement('span');
    number.className = 'step-num'; number.textContent = String(index + 1).padStart(2, '0');
    narrative.textContent = maneuver.narrative || 'Continue along route';
    distance.className = 'step-distance'; distance.textContent = maneuver.distance ? Number(maneuver.distance).toFixed(1) + ' km' : '';
    li.append(number, narrative, distance); stepsList.append(li);
  });
}

function formatDuration(minutes) {
  if (minutes < 60) return minutes + ' min';
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return remainder ? hours + ' hr ' + remainder + ' min' : hours + ' hr';
}

function clearRoute() {
  if (routeLayer) map.removeLayer(routeLayer);
  if (originMarker) map.removeLayer(originMarker);
  if (destinationMarker) map.removeLayer(destinationMarker);
  routeLayer = originMarker = destinationMarker = null;
  resultBox.hidden = true;
  mapCaption.textContent = cameras.length ? cameras.length.toLocaleString() + ' camera points loaded' : 'Open map · no camera tiles loaded';
  if (cameras.length) renderCameraLayer();
  setStatus('Route cleared. Your location is not retained.');
}
