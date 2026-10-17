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

export default {
  async fetch(request) {
    const url = new URL(request.url);
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
