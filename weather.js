// Current weather for the garden sky.
// Primary source: Open-Meteo (https://open-meteo.com) — free for non-commercial use, under
//   10,000 calls/day, attribution required (CC BY 4.0). We cache for 15 minutes, so at most ~96 calls/day.
// Fallback: MET Norway Locationforecast 2.0 (https://api.met.no/doc/TermsOfService) — requires an
//   identifying User-Agent with contact info, coordinates with at most 4 decimals, honouring the
//   Expires header (no requests before it), If-Modified-Since on revalidation, and attribution (CC BY 4.0).
// The browser only ever talks to this server, so the viewer's IP never reaches either provider.

const pkg = require("./package.json");

const LAT = round4(Number(process.env.WEATHER_LAT || 45.6715)); // Castelfranco Veneto
const LON = round4(Number(process.env.WEATHER_LON || 11.9274));
const PLACE = process.env.WEATHER_PLACE || "Castelfranco Veneto";
const CONTACT = process.env.WEATHER_CONTACT || "https://github.com/ayaderaghul/chore-garden";
const USER_AGENT = `chore-garden/${pkg.version} (${CONTACT})`;
const FRESH_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 8000;

function round4(n) { return Math.round(n * 1e4) / 1e4; }

let cached = null;       // last normalized result we served
let inFlight = null;     // coalesces concurrent refreshes
let backoffUntil = 0;    // after both sources fail, wait before asking again
const met = { body: null, lastModified: null, expires: 0 }; // MET's own cache state

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

// Sun above the horizon? (used for MET symbols that carry no _day/_night suffix)
function sunUp(date, lat, lon) {
  const rad = Math.PI / 180;
  const d = (date.getTime() / 86400000) - 10957.5; // days since J2000
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

function result(kind, intensity, isDay, temp, source, sourceUrl) {
  return { kind, intensity, isDay, temp: temp == null ? null : Math.round(temp), label: LABELS[kind], place: PLACE, source, sourceUrl, fetchedAt: Date.now() };
}

async function fromOpenMeteo() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,weather_code,is_day&timezone=auto`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const j = await res.json();
  const c = j.current;
  if (!c || typeof c.weather_code !== "number") throw new Error("Open-Meteo: no current data");
  const [kind, intensity] = fromWmo(c.weather_code);
  return result(kind, intensity, c.is_day === 1, c.temperature_2m, "Open-Meteo", "https://open-meteo.com/");
}

async function fromMetNorway() {
  // Only contact MET when its Expires time has passed; otherwise reuse what it sent us.
  if (!met.body || Date.now() >= met.expires) {
    const headers = { "User-Agent": USER_AGENT, "Accept": "application/json" };
    if (met.lastModified) headers["If-Modified-Since"] = met.lastModified;
    const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${LAT}&lon=${LON}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const expires = Date.parse(res.headers.get("expires") || "");
    met.expires = Number.isFinite(expires) ? expires : Date.now() + 30 * 60 * 1000;
    if (res.status === 304 && met.body) {
      // unchanged; keep body
    } else if (res.ok) {
      met.body = await res.json();
      met.lastModified = res.headers.get("last-modified");
      if (res.status === 203) console.warn("MET Norway: this API version is deprecated (203)");
    } else {
      throw new Error(`MET Norway ${res.status}`);
    }
  }
  const series = met.body?.properties?.timeseries || [];
  const now = Date.now();
  // the latest step that has started, or the first one
  let step = series[0];
  for (const t of series) { if (Date.parse(t.time) <= now) step = t; else break; }
  if (!step) throw new Error("MET Norway: no timeseries");
  const sym = step.data?.next_1_hours?.summary?.symbol_code || step.data?.next_6_hours?.summary?.symbol_code;
  const [kind, intensity] = fromMetSymbol(sym);
  const isDay = /_night$/.test(sym || "") ? false : /_(day|polartwilight)$/.test(sym || "") ? true : sunUp(new Date(), LAT, LON);
  return result(kind, intensity, isDay, step.data?.instant?.details?.air_temperature, "MET Norway", "https://api.met.no/");
}

async function refresh() {
  try {
    return (cached = await fromOpenMeteo());
  } catch (e1) {
    console.warn("Weather: Open-Meteo failed, trying MET Norway:", e1.message);
    try {
      return (cached = await fromMetNorway());
    } catch (e2) {
      console.warn("Weather: MET Norway failed:", e2.message);
      backoffUntil = Date.now() + 5 * 60 * 1000;
      if (cached) return cached; // stale is better than nothing
      throw new Error("Weather is unavailable right now");
    }
  }
}

async function getWeather() {
  if (cached && Date.now() - cached.fetchedAt < FRESH_MS) return cached;
  if (Date.now() < backoffUntil) { if (cached) return cached; throw new Error("Weather is unavailable right now"); }
  if (!inFlight) inFlight = refresh().finally(() => { inFlight = null; });
  return inFlight;
}

module.exports = { getWeather, _test: { fromWmo, fromMetSymbol, sunUp } };
