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
const bufferInput = document.querySelector('#buffer');
const bufferOutput = document.querySelector('#buffer-output');
const statusBox = document.querySelector('#status');
const resultBox = document.querySelector('#route-result');
const routeSummary = document.querySelector('#route-summary');
const stepsList = document.querySelector('#steps');
const mapCaption = document.querySelector('#map-caption');
const clearButton = document.querySelector('#clear-button');
let cameras = [];
let cameraLayer = L.layerGroup().addTo(map);
let routeLayer = null, originMarker = null, destinationMarker = null;
const MAX_CAMERAS = 12000, EARTH_RADIUS = 6371000;
document.querySelector('#key-form').addEventListener('submit', event => event.preventDefault());
bufferInput.addEventListener('input', () => { bufferOutput.value = bufferInput.value + ' m'; });
cameraToggle.addEventListener('change', () => { if (cameraToggle.checked) cameraLayer.addTo(map); else map.removeLayer(cameraLayer); });
cameraFile.addEventListener('change', importCameraFile);
routeButton.addEventListener('click', startRoute);
clearButton.addEventListener('click', clearRoute);
destinationInput.addEventListener('keydown', event => { if (event.key === 'Enter') startRoute(); });
function setStatus(message, kind) { statusBox.textContent = message; statusBox.className = 'status' + (kind ? ' ' + kind : ''); }
function readPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser does not provide location access.'));
    navigator.geolocation.getCurrentPosition(position => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }), error => reject(new Error(error.code === 1 ? 'Location permission was declined. Allow location access, then try again.' : error.code === 2 ? 'Your location could not be determined. Try again from a place with a clearer GPS signal.' : 'Location took too long. Try again.')), { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}
async function startRoute() {
  const key = keyInput.value.trim(), destination = destinationInput.value.trim();
  if (!key) return setStatus('Enter your MapQuest API key to request directions.', 'error');
  if (!destination) return setStatus('Enter a destination first.', 'error');
  routeButton.disabled = true; routeButton.querySelector('span:first-child').textContent = 'Finding your location…'; resultBox.hidden = true;
  setStatus('Waiting for location permission. Your browser will ask before sharing GPS.');
  try {
    const origin = await readPosition();
    mapCaption.textContent = 'Location acquired · calculating route';
    setStatus(cameras.length ? 'Calculating a route and checking nearby camera points…' : 'No camera file loaded. Calculating a standard route.');
    const outcome = await calculateAvoidingRoute(key, origin, destination, Number(bufferInput.value));
    renderRoute(outcome.route, origin, destination);
    const nearby = findNearbyCameras(outcome.route, Number(bufferInput.value));
    const avoidedCount = outcome.avoidedCameraIds.size;
    let note = outcome.cameraDataLoaded ? avoidedCount + ' camera point' + (avoidedCount === 1 ? '' : 's') + ' prompted road-link avoidance' : 'no camera data loaded; this is a standard route';
    if (nearby.length) note += '. ' + nearby.length + ' known point' + (nearby.length === 1 ? '' : 's') + ' remain within ' + bufferInput.value + ' m';
    if (outcome.warning) note += '. ' + outcome.warning;
    setStatus(note + '. Camera inventory may be incomplete; avoidance is best-effort, not a guarantee.', nearby.length || outcome.warning ? 'warning' : 'success');
    resultBox.hidden = false; mapCaption.textContent = cameras.length.toLocaleString() + ' camera point' + (cameras.length === 1 ? '' : 's') + ' · location held in this tab';
  } catch (error) { setStatus(error.message || 'Could not calculate this route. Check the API key and connection.', 'error'); mapCaption.textContent = 'No location requested beyond this route attempt'; }
  finally { routeButton.disabled = false; routeButton.querySelector('span:first-child').textContent = 'Route from my location'; }
}
async function calculateAvoidingRoute(key, origin, destination, radius) {
  const blockedLinks = new Set(), avoidedCameraIds = new Set();
  let lastSuccess = null, warning = '';
  const maxPasses = cameras.length ? 5 : 1;
  for (let pass = 0; pass < maxPasses; pass++) {
    let route;
    try { route = await requestMapQuestRoute(key, origin, destination, Array.from(blockedLinks)); }
    catch (error) { if (lastSuccess) { warning = 'MapQuest could not complete another avoidance pass; showing the last successful route'; break; } throw error; }
    lastSuccess = route;
    if (!cameras.length) break;
    const near = findNearbyCameras(route, radius), newlyFound = new Set();
    for (const camera of near) {
      const ids = linksNearCamera(route, camera, radius);
      if (ids.length) { avoidedCameraIds.add(camera.id); for (const id of ids) if (!blockedLinks.has(id)) newlyFound.add(id); }
    }
    if (!newlyFound.size) break;
    for (const id of newlyFound) { if (blockedLinks.size >= 100) break; blockedLinks.add(id); }
    if (pass === maxPasses - 1) warning = 'Reached the reroute limit';
  }
  if (!lastSuccess) throw new Error('MapQuest did not return a route.');
  return { route: lastSuccess, avoidedCameraIds, cameraDataLoaded: cameras.length > 0, warning };
}
async function requestMapQuestRoute(key, origin, destination, avoidIds) {
  const params = new URLSearchParams({ key: key, from: origin.lat + ',' + origin.lng, to: destination, routeType: 'fastest', unit: 'k', fullShape: 'true', shapeFormat: 'raw', maxLinkId: '10', narrativeType: 'text', outFormat: 'json' });
  if (avoidIds.length) params.set('mustAvoidLinkIds', avoidIds.join(','));
  let response;
  try { response = await fetch('https://www.mapquestapi.com/directions/v2/route?' + params.toString()); }
  catch { throw new Error('Could not reach MapQuest. Check your connection and try again.'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('MapQuest returned an unreadable response.'); }
  if (!response.ok) throw new Error('MapQuest request failed (' + response.status + ').');
  if (data.info && data.info.statuscode !== 0 || !data.route) throw new Error(((data.info && data.info.messages && data.info.messages[0]) || 'No route was returned.') + ' Check your API key and destination.');
  return data.route;
}
function getShape(route) {
  const raw = (route.shape && route.shape.shapePoints) || route.shapePoints || [], points = [];
  if (Array.isArray(raw) && raw.length && typeof raw[0] === 'object') {
    for (const point of raw) { const lat = Number(point.lat ?? point.latitude), lng = Number(point.lng ?? point.lon ?? point.longitude); if (Number.isFinite(lat) && Number.isFinite(lng)) points.push([lat, lng]); }
  } else for (let i = 0; i + 1 < raw.length; i += 2) { const lat = Number(raw[i]), lng = Number(raw[i + 1]); if (Number.isFinite(lat) && Number.isFinite(lng)) points.push([lat, lng]); }
  return points;
}
function getManeuverStarts(route) { return (route.shape && route.shape.maneuverIndexes) || route.maneuverIndexes || []; }
function getManeuvers(route) { return (route.legs || []).flatMap(leg => leg.maneuvers || []); }
function linksNearCamera(route, camera, radius) {
  const points = getShape(route); if (points.length < 2) return [];
  let closestDistance = Infinity, closestSegment = -1;
  for (let i = 0; i < points.length - 1; i++) { const distance = pointToSegmentMeters(camera, points[i], points[i + 1]); if (distance < closestDistance) { closestDistance = distance; closestSegment = i; } }
  if (closestDistance > radius || closestSegment < 0) return [];
  const starts = getManeuverStarts(route);
  let maneuverIndex = -1;
  for (let i = 0; i < starts.length; i++) if (starts[i] <= closestSegment) maneuverIndex = i;
  const maneuver = getManeuvers(route)[maneuverIndex];
  return (maneuver && maneuver.linkIds || []).map(String).filter(id => /^\d+$/.test(id));
}
function pointToSegmentMeters(point, start, end) {
  const cos = Math.cos(point.lat * Math.PI / 180);
  const project = p => ({ x: (p[1] - point.lng) * Math.PI / 180 * EARTH_RADIUS * cos, y: (p[0] - point.lat) * Math.PI / 180 * EARTH_RADIUS });
  const a = project(start), b = project(end), dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
  const t = length2 ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / length2)) : 0;
  return Math.hypot(a.x + t * dx, a.y + t * dy);
}
function findNearbyCameras(route, radius) {
  const points = getShape(route); if (!points.length) return [];
  return cameras.filter(camera => {
    if (points.length === 1) return pointToSegmentMeters(camera, points[0], points[0]) <= radius;
    for (let i = 0; i < points.length - 1; i++) if (pointToSegmentMeters(camera, points[i], points[i + 1]) <= radius) return true;
    return false;
  });
}
function renderRoute(route, origin, destinationText) {
  const points = getShape(route); if (!points.length) throw new Error('MapQuest returned directions without route geometry.');
  if (routeLayer) map.removeLayer(routeLayer); if (originMarker) map.removeLayer(originMarker); if (destinationMarker) map.removeLayer(destinationMarker);
  routeLayer = L.polyline(points, { color: '#537cde', weight: 5, opacity: 0.9, lineCap: 'round', lineJoin: 'round' }).addTo(map);
  originMarker = L.circleMarker([origin.lat, origin.lng], { radius: 7, color: '#fff', weight: 3, fillColor: '#68882c', fillOpacity: 1 }).addTo(map).bindTooltip('Your location', { direction: 'top', offset: [0, -8] });
  const destinationPoint = route.locations && route.locations.length && route.locations[route.locations.length - 1].latLng;
  if (destinationPoint && Number.isFinite(destinationPoint.lat) && Number.isFinite(destinationPoint.lng)) destinationMarker = L.circleMarker([destinationPoint.lat, destinationPoint.lng], { radius: 7, color: '#fff', weight: 3, fillColor: '#e06759', fillOpacity: 1 }).addTo(map).bindTooltip(destinationText, { direction: 'top', offset: [0, -8] });
  map.fitBounds(routeLayer.getBounds().pad(0.13), { maxZoom: 15 });
  const km = Number(route.distance || 0), minutes = Math.round(Number(route.time || 0) / 60);
  routeSummary.textContent = (km < 10 ? km.toFixed(1) : Math.round(km)) + ' km · ' + formatDuration(minutes);
  stepsList.replaceChildren();
  getManeuvers(route).forEach((maneuver, index) => {
    const li = document.createElement('li'), number = document.createElement('span'), narrative = document.createElement('span'), distance = document.createElement('span');
    number.className = 'step-num'; number.textContent = String(index + 1).padStart(2, '0');
    narrative.textContent = maneuver.narrative || 'Continue along route';
    distance.className = 'step-distance'; distance.textContent = maneuver.distance ? Number(maneuver.distance).toFixed(1) + ' km' : '';
    li.append(number, narrative, distance); stepsList.append(li);
  });
}
function formatDuration(minutes) { if (minutes < 60) return minutes + ' min'; const hours = Math.floor(minutes / 60), remainder = minutes % 60; return remainder ? hours + ' hr ' + remainder + ' min' : hours + ' hr'; }
async function importCameraFile(event) {
  const file = event.target.files && event.target.files[0]; if (!file) return;
  try {
    const text = await file.text(), imported = file.name.toLowerCase().endsWith('.csv') ? parseCsv(text) : parseGeoJson(JSON.parse(text));
    if (!imported.length) throw new Error('No valid coordinate points were found.');
    if (imported.length > MAX_CAMERAS) throw new Error('This file has more than ' + MAX_CAMERAS.toLocaleString() + ' points. Split it into a smaller local area.');
    cameras = imported.map((item, index) => ({ ...item, id: String(item.id ?? index) })); drawCameraLayer();
    cameraCount.textContent = cameras.length.toLocaleString() + ' loaded'; uploadLabel.textContent = file.name;
    setStatus(cameras.length.toLocaleString() + ' camera points loaded locally. No file was uploaded.', 'success');
    if (cameraLayer.getLayers().length) map.fitBounds(cameraLayer.getBounds().pad(0.12), { maxZoom: 14 });
  } catch (error) { setStatus(error.message || 'Could not read that camera-location file.', 'error'); }
  finally { cameraFile.value = ''; }
}
function parseGeoJson(data) {
  const found = [];
  const addFeature = feature => {
    if (!feature || !feature.geometry) return;
    const properties = feature.properties || {}, name = properties.name || properties.title || properties.operator || properties.type || 'Known camera location';
    const addPoint = coordinates => { const lng = Number(coordinates && coordinates[0]), lat = Number(coordinates && coordinates[1]); if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) found.push({ lat: lat, lng: lng, name: name, id: properties.id }); };
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
  const splitRow = line => { const cells = []; let cell = '', quoted = false; for (let i = 0; i < line.length; i++) { const char = line[i]; if (char === '"' && line[i + 1] === '"' && quoted) { cell += '"'; i++; } else if (char === '"') quoted = !quoted; else if (char === ',' && !quoted) { cells.push(cell.trim()); cell = ''; } else cell += char; } cells.push(cell.trim()); return cells; };
  const headers = splitRow(rows[0]).map(value => value.toLowerCase().replace(/[ _-]/g, ''));
  const latIndex = headers.findIndex(value => ['lat', 'latitude', 'y'].includes(value)), lngIndex = headers.findIndex(value => ['lng', 'lon', 'long', 'longitude', 'x'].includes(value));
  if (latIndex < 0 || lngIndex < 0) throw new Error('CSV needs latitude and longitude columns.');
  const nameIndex = headers.findIndex(value => ['name', 'title', 'operator', 'type', 'location'].includes(value));
  return rows.slice(1).map(line => { const cells = splitRow(line), lat = Number(cells[latIndex]), lng = Number(cells[lngIndex]); return { lat: lat, lng: lng, name: nameIndex >= 0 && cells[nameIndex] ? cells[nameIndex] : 'Known camera location' }; }).filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng) && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180);
}
function drawCameraLayer() {
  cameraLayer.clearLayers();
  for (const camera of cameras) {
    const marker = L.circleMarker([camera.lat, camera.lng], { radius: 6, color: '#fff', weight: 1.5, fillColor: '#e9655b', fillOpacity: 0.95 });
    const popup = document.createElement('div'); popup.className = 'camera-popup';
    const title = document.createElement('strong'); title.textContent = camera.name;
    const coordinates = document.createElement('span'); coordinates.textContent = camera.lat.toFixed(5) + ', ' + camera.lng.toFixed(5);
    popup.append(title, coordinates); marker.bindPopup(popup); marker.addTo(cameraLayer);
  }
}
function clearRoute() {
  if (routeLayer) map.removeLayer(routeLayer); if (originMarker) map.removeLayer(originMarker); if (destinationMarker) map.removeLayer(destinationMarker);
  routeLayer = originMarker = destinationMarker = null; resultBox.hidden = true;
  mapCaption.textContent = cameras.length ? cameras.length.toLocaleString() + ' camera points · no location requested' : 'Open map · no location requested';
  if (cameras.length && cameraLayer.getLayers().length) map.fitBounds(cameraLayer.getBounds().pad(0.12), { maxZoom: 14 });
  setStatus('Route cleared. Your location is not retained.');
}
