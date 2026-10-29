// City search, so the garden's weather can follow any place.
//
// Public APIs used here:
//  1. Open-Meteo Geocoding — https://open-meteo.com/en/docs/geocoding-api (same terms as the forecast:
//     non-commercial, under 10,000 calls/day, attribution; place data from GeoNames, CC BY 4.0).
//  2. OpenStreetMap Nominatim (fallback) — https://operations.osmfoundation.org/policies/nominatim/
//     At most 1 request per second, identifying User-Agent, results must be cached, no search-as-you-type,
//     attribution "© OpenStreetMap contributors" (ODbL).
//
// For both: searches run only when the person presses Search (never per keystroke), every answer is cached
// in the database for 30 days, and failures pause each service separately (see services.js).

const OM_GEO = "Open-Meteo geocoding", OSM = "OpenStreetMap Nominatim";
const SERVICES = [OM_GEO, OSM];
const CACHE_MS = 30 * 24 * 60 * 60 * 1000;

let store, services, userAgent;
let osmQueue = Promise.resolve(), osmLast = 0; // enforce Nominatim's 1 request/second, one at a time
const recent = [];                             // our own guard: at most 10 searches a minute reach the providers

function init(s, svc, ua) { store = s; services = svc; userAgent = ua; }

const round4 = n => Math.round(n * 1e4) / 1e4;
const normalize = q => String(q || "").normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

async function fromOpenMeteo(q) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`;
  const res = await services.call(OM_GEO, url, { "User-Agent": userAgent });
  const j = await res.json();
  return (j.results || []).map(r => ({
    name: r.name, region: r.admin1 || "", country: r.country || "",
    lat: round4(r.latitude), lon: round4(r.longitude),
  }));
}

function fromOsm(q) {
  // Chain calls so two searches never overlap, and space them at least 1.1 s apart.
  const run = osmQueue.then(async () => {
    const wait = osmLast + 1100 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    osmLast = Date.now();
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&limit=6&featureType=settlement&accept-language=en`;
    const res = await services.call(OSM, url, { "User-Agent": userAgent, "Accept": "application/json" });
    const j = await res.json();
    return (Array.isArray(j) ? j : []).map(r => {
      const a = r.address || {};
      return {
        name: r.name || a.city || a.town || a.village || a.municipality || String(r.display_name || "").split(",")[0],
        region: a.state || a.region || a.county || "", country: a.country || "",
        lat: round4(Number(r.lat)), lon: round4(Number(r.lon)),
      };
    });
  });
  osmQueue = run.catch(() => {});
  return run;
}

// Returns { results, source, cached } or throws an Error with a message for the person.
async function search(rawQuery) {
  const q = normalize(rawQuery);
  if (q.length < 2 || q.length > 80) { const e = new Error("Type at least 2 letters"); e.status = 400; throw e; }

  const hit = await store.get("geo:" + q);
  if (hit && Date.now() - hit.at < CACHE_MS) return { results: hit.results, source: hit.source, cached: true };

  const now = Date.now();
  while (recent.length && now - recent[0] > 60000) recent.shift();
  if (recent.length >= 10) { const e = new Error("Too many searches. Wait a minute and try again."); e.status = 429; throw e; }
  recent.push(now);

  let results = null, source = null;
  try {
    results = await fromOpenMeteo(q); source = "Open-Meteo";
  } catch (e) { console.warn("Places:", e.message); }
  if (!results || !results.length) {
    try {
      const osm = await fromOsm(q);
      if (osm.length || !results) { results = osm; source = "OpenStreetMap"; }
    } catch (e) { console.warn("Places:", e.message); }
  }
  if (!results) { const e = new Error("City search is unavailable right now. Try again later."); e.status = 503; throw e; }

  results = results.filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lon) && r.name);
  await store.set("geo:" + q, { results, source, at: Date.now() });
  return { results, source, cached: false };
}

function notices() { return services.notices(SERVICES); }

module.exports = { init, search, notices, SERVICES };
