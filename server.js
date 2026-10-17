const TILEJSON_URLS = {
  us: "https://deflock.dontgetflocked.com/cameras-us-hourly.json",
  ca: "https://deflock.dontgetflocked.com/cameras-ca-hourly.json",
};
const TILEJSON_TTL_MS = 5 * 60 * 1000;
const tileJsonCache = new Map();

async function getTileJson(country) {
  const cached = tileJsonCache.get(country);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;
  const promise = (async () => {
    const response = await fetch(TILEJSON_URLS[country], { cf: { cacheTtl: 60, cacheEverything: true } });
    if (!response.ok) throw new Error("Camera tile index unavailable");
    const data = await response.json();
    if (!Array.isArray(data.tiles) || !data.tiles[0]) throw new Error("Camera tile index invalid");
    const template = new URL(data.tiles[0].replaceAll("{z}", "0").replaceAll("{x}", "0").replaceAll("{y}", "0"));
    const path = decodeURIComponent(template.pathname);
    const expected = new RegExp("^/cameras-" + country + "-hourly-[a-z0-9-]+/\\d+/\\d+/\\d+\\.mvt$");
    if (!new Set(["deflock.dontgetflocked.com", "tiles.dontgetflocked.com"]).has(template.hostname) || !expected.test(path)) {
      throw new Error("Camera tile URL rejected");
    }
    return {
      template: data.tiles[0],
      minZoom: Math.max(9, Number(data.minzoom) || 9),
      maxZoom: Math.min(14, Number(data.maxzoom) || 14),
      build: String(data.build || ""),
      updatedAt: response.headers.get("last-modified"),
    };
  })();
  tileJsonCache.set(country, { expiresAt: Date.now() + TILEJSON_TTL_MS, promise });
  try { return await promise; }
  catch (error) { tileJsonCache.delete(country); throw error; }
}

async function geocode(query) {
  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "6");
  url.searchParams.set("lang", "en");
  const response = await fetch(url.toString(), { headers: { Accept: "application/geo+json, application/json" } });
  if (!response.ok) throw new Error("Place search is temporarily unavailable");
  const data = await response.json();
  const seen = new Set();
  const places = [];
  for (const feature of data.features || []) {
    const coordinates = feature.geometry && feature.geometry.coordinates;
    const properties = feature.properties || {};
    if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
    const lng = Number(coordinates[0]), lat = Number(coordinates[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const street = [properties.housenumber, properties.street].filter(Boolean).join(" ");
    const primary = street || properties.name || properties.city || "Place";
    const parts = [primary, properties.city, properties.state, properties.country].filter(Boolean);
    const label = parts.filter((part, index) => parts.indexOf(part) === index).join(", ");
    const key = lat.toFixed(5) + "," + lng.toFixed(5);
    if (seen.has(key)) continue;
    seen.add(key);
    places.push({ label, lat, lng, detail: [properties.type, properties.osm_value].filter(Boolean).join(" · ") });
    if (places.length === 5) break;
  }
  return places;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/geocode") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      let body;
      try { body = await request.json(); }
      catch { return Response.json({ error: "Send a JSON place query." }, { status: 400 }); }
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (!query || query.length > 180 || /[\u0000-\u001f]/.test(query)) {
        return Response.json({ error: "Enter a place or address under 180 characters." }, { status: 400 });
      }
      try {
        const places = await geocode(query);
        return Response.json({ places }, { headers: { "Cache-Control": "private, no-store" } });
      } catch {
        return Response.json({ error: "Place search is temporarily unavailable." }, { status: 502 });
      }
    }

    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

    if (url.pathname === "/api/camera-index") {
      const entries = await Promise.all(Object.keys(TILEJSON_URLS).map(async country => {
        try { return [country, await getTileJson(country)]; }
        catch { return [country, null]; }
      }));
      const countries = Object.fromEntries(entries.filter(([, source]) => source));
      if (!Object.keys(countries).length) return Response.json({ error: "Live camera tile sources are temporarily unavailable." }, { status: 502 });
      return Response.json({ countries }, { headers: { "Cache-Control": "public, max-age=60, s-maxage=300" } });
    }

    if (url.pathname === "/api/camera-tile") {
      const country = url.searchParams.get("country");
      const z = Number(url.searchParams.get("z"));
      const x = Number(url.searchParams.get("x"));
      const y = Number(url.searchParams.get("y"));
      if (!Object.hasOwn(TILEJSON_URLS, country) || ![z, x, y].every(Number.isInteger) || z < 9 || z > 14 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) {
        return Response.json({ error: "Invalid camera tile coordinates." }, { status: 400 });
      }
      try {
        const source = await getTileJson(country);
        if (z < source.minZoom || z > source.maxZoom) return new Response(null, { status: 204 });
        const remoteUrl = new URL(source.template.replaceAll("{z}", String(z)).replaceAll("{x}", String(x)).replaceAll("{y}", String(y)));
        if (!new Set(["deflock.dontgetflocked.com", "tiles.dontgetflocked.com"]).has(remoteUrl.hostname)) {
          return Response.json({ error: "Camera tile host rejected." }, { status: 502 });
        }
        const upstream = await fetch(remoteUrl.toString(), { cf: { cacheTtl: 86400, cacheEverything: true } });
        if (upstream.status === 404) return new Response(null, { status: 204, headers: { "Cache-Control": "public, max-age=3600, s-maxage=86400" } });
        if (!upstream.ok) return Response.json({ error: "Camera tile could not be loaded." }, { status: 502 });
        return new Response(await upstream.arrayBuffer(), {
          headers: {
            "Content-Type": "application/vnd.mapbox-vector-tile",
            "Cache-Control": "public, max-age=3600, s-maxage=86400",
          },
        });
      } catch {
        return Response.json({ error: "Camera tile source is temporarily unavailable." }, { status: 502 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};
