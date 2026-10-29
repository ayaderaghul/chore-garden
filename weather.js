// Current weather for the garden sky, at the location chosen in the app (see places.js for city search).
//
// Public APIs used here:
//  1. Open-Meteo forecast — https://open-meteo.com/en/terms
//     Free for non-commercial use, under 10,000 calls/day (also 5,000/hour, 600/minute), attribution (CC BY 4.0).
//     Each location's result is cached 15 minutes in the database, so restarts and switching cities back and
//     forth don't refetch.
//  2. MET Norway Locationforecast 2.0 — https://api.met.no/doc/TermsOfService
//     Identifying User-Agent with contact info, coordinates with at most 4 decimals, no new request before
//     the Expires time, If-Modified-Since with the stored Last-Modified, attribution (CC BY 4.0).
//     Expires, Last-Modified and the forecast are saved per location in the database (survive restarts).
//
// Privacy: the browser only talks to this server; the server makes these calls.
// No background polling: the server fetches only when an open, visible page asks for /api/weather.
// Failures pause each service separately (see services.js).

const pkg = require("./package.json");

const CONTACT = process.env.WEATHER_CONTACT || "https://github.com/ayaderaghul/chore-garden";
const USER_AGENT = `chore-garden/${pkg.version} (${CONTACT})`;
const FRESH_MS = 15 * 60 * 1000;
const OPEN_METEO = "Open-Meteo", MET = "MET Norway";
const SERVICES = [OPEN_METEO, MET];

function round4(n) { return Math.round(n * 1e4) / 1e4; }

const DEFAULT_LOCATION = {
  name: process.env.WEATHER_PLACE || "Castelfranco Veneto",
  region: "Veneto", country: "Italy",
  lat: round4(Number(process.env.WEATHER_LAT || 45.6715)),
  lon: round4(Number(process.env.WEATHER_LON || 11.9274)),
};

let store, services;
let loc = DEFAULT_LOCATION;           // persisted as "settings:location"
const results = new Map();            // locKey -> last normalized result   (persisted as "weather:<key>")
const metCache = new Map();           // locKey -> {body, lastModified, expires} (persisted as "met:<key>")
const inFlight = new Map();           // locKey -> refresh promise

const keyOf = l => `${l.lat},${l.lon}`;

async function init(s, svc) {
  store = s; services = svc;
  const saved = await store.get("settings:location");
  if (saved) loc = saved;
  // Carry over the forecast saved before per-location caching existed, so MET's Expires is still honoured.
  const old = await store.get("met:locationforecast");
  if (old && !(await store.get("met:" + keyOf(DEFAULT_LOCATION)))) await store.set("met:" + keyOf(DEFAULT_LOCATION), old);
}

function getLocation() { return loc; }

async function setLocation(l) {
  loc = { name: l.name, region: l.region || "", country: l.country || "", lat: round4(l.lat), lon: round4(l.lon) };
  await store.set("settings:location", loc);
  return loc;
}

async function cachedResult(key) {
  if (!results.has(key)) results.set(key, await store.get("weather:" + key));
  return results.get(key);
}
async function metState(key) {
  if (!metCache.has(key)) metCache.set(key, (await store.get("met:" + key)) || { body: null, lastModified: null, expires: 0 });
  return metCache.get(key);
}

// ---- normalized shape ----
// { kind: clear|partly|cloudy|fog|drizzle|rain|snow|thunder, intensity: 0-3, isDay, temp, label, place, source, sourceUrl, fetchedAt }
const LABELS = { clear: "Clear", partly: "Partly cloudy", cloudy: "Cloudy", fog: "Fog", drizzle: "Drizzle", rain: "Rain", snow: "Snow", thunder: "Thunderstorm" };

function fromWmo(code) {
  if (code === 0) return ["clear", 0];
  if (code === 1 || code === 2) return ["partly", 0];
  if (code === 3) return ["cloudy", 0];
  if (code === 45 || code === 48) return ["fog", 0];
  if (code >= 51 && code <= 57) return ["drizzle", code >= 55 ? 2 : 1];
  if ([61, 66, 80].includes(code)) return ["rain", 1];
  if ([63, 81].includes(code)) return ["rain", 2];
  if ([65, 67, 82].includes(code)) return ["rain", 3];
  if ([71, 77, 85].includes(code)) return ["snow", 1];
  if (code === 73) return ["snow", 2];
  if ([75, 86].includes(code)) return ["snow", 3];
  if (code >= 95) return ["thunder", 3];
  return ["cloudy", 0];
}

function fromMetSymbol(sym) {
  const s = String(sym || "").replace(/_(day|night|polartwilight)$/, "");
  const heavy = s.startsWith("heavy"), light = s.startsWith("light");
  const intensity = heavy ? 3 : light ? 1 : 2;
  if (s.includes("thunder")) return ["thunder", 3];
  if (s.includes("snow") || s.includes("sleet")) return ["snow", intensity];
  if (s.includes("rain")) return light ? ["drizzle", 1] : ["rain", intensity];
  if (s === "fog") return ["fog", 0];
  if (s === "cloudy") return ["cloudy", 0];
  if (s === "partlycloudy" || s === "fair") return ["partly", 0];
  if (s === "clearsky") return ["clear", 0];
  return ["cloudy", 0];
}

// Sun above the horizon? (for MET symbols that carry no _day/_night suffix)
function sunUp(date, lat, lon) {
  const rad = Math.PI / 180;
  const d = (date.getTime() / 86400000) - 10957.5;
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = ((gmst * 15 + lon) * rad) - ra;
  const elev = Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha));
  return elev / rad > -0.83;
}

function result(l, kind, intensity, isDay, temp, source, sourceUrl) {
  return { kind, intensity, isDay, temp: temp == null ? null : Math.round(temp), label: LABELS[kind], place: l.name, source, sourceUrl, fetchedAt: Date.now() };
}

async function fromOpenMeteo(l) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${l.lat}&longitude=${l.lon}&current=temperature_2m,weather_code,is_day&timezone=auto`;
  const res = await services.call(OPEN_METEO, url, { "User-Agent": USER_AGENT });
  const c = (await res.json()).current;
  if (!c || typeof c.weather_code !== "number") throw new Error("Open-Meteo: no current data");
  const [kind, intensity] = fromWmo(c.weather_code);
  return result(l, kind, intensity, c.is_day === 1, c.temperature_2m, OPEN_METEO, "https://open-meteo.com/");
}

async function fromMetNorway(l) {
  const key = keyOf(l);
  let met = await metState(key);
  // Contact MET only once its Expires time has passed; until then reuse what it sent us.
  if (!met.body || Date.now() >= met.expires) {
    const headers = { "User-Agent": USER_AGENT, "Accept": "application/json" };
    if (met.body && met.lastModified) headers["If-Modified-Since"] = met.lastModified;
    const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${l.lat}&lon=${l.lon}`;
    const res = await services.call(MET, url, headers);
    const expires = Date.parse(res.headers.get("expires") || "");
    const next = { ...met, expires: Number.isFinite(expires) ? expires : Date.now() + 30 * 60 * 1000 };
    if (res.status !== 304) {
      next.body = await res.json();
      next.lastModified = res.headers.get("last-modified") || null;
      if (res.status === 203) console.warn("[MET Norway] this API version is deprecated (203)");
    }
    met = next;
    metCache.set(key, met);
    await store.set("met:" + key, met);
  }
  const series = met.body?.properties?.timeseries || [];
  const now = Date.now();
  let step = series[0];
  for (const t of series) { if (Date.parse(t.time) <= now) step = t; else break; }
  if (!step) throw new Error("MET Norway: no timeseries");
  const sym = step.data?.next_1_hours?.summary?.symbol_code || step.data?.next_6_hours?.summary?.symbol_code;
  const [kind, intensity] = fromMetSymbol(sym);
  const isDay = /_night$/.test(sym || "") ? false : /_(day|polartwilight)$/.test(sym || "") ? true : sunUp(new Date(), l.lat, l.lon);
  return result(l, kind, intensity, isDay, step.data?.instant?.details?.air_temperature, MET, "https://api.met.no/");
}

async function refresh(l) {
  const key = keyOf(l);
  for (const source of [fromOpenMeteo, fromMetNorway]) {
    try {
      const r = await source(l);
      results.set(key, r);
      await store.set("weather:" + key, r);
      return;
    } catch (e) {
      console.warn("Weather:", e.message);
    }
  }
}

// Returns { weather: result|null, stale, location, notices }
async function getWeather() {
  const l = loc, key = keyOf(l);
  let r = await cachedResult(key);
  if (!r || Date.now() - r.fetchedAt >= FRESH_MS) {
    if (!inFlight.has(key)) inFlight.set(key, refresh(l).finally(() => inFlight.delete(key)));
    await inFlight.get(key);
    r = results.get(key) || null;
  }
  if (r) r = { ...r, place: l.name }; // the name the user picked, even if the reading was cached under it before
  const stale = !r || Date.now() - r.fetchedAt >= FRESH_MS;
  return { weather: r, stale, location: l, notices: services.notices(SERVICES) };
}

// The weather we already have for the current location, without contacting any service.
// Used to stamp each completion; null if nothing from the last 3 hours.
function snapshot() {
  const r = results.get(keyOf(loc));
  if (!r || Date.now() - r.fetchedAt > 3 * 60 * 60 * 1000) return null;
  return { ...r, place: loc.name };
}

module.exports = { init, getWeather, getLocation, setLocation, snapshot, SERVICES, USER_AGENT, _test: { fromWmo, fromMetSymbol, sunUp } };
