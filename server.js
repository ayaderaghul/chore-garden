const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const weather = require("./weather");
const places = require("./places");
const { createServices } = require("./services");

const { DATABASE_URL, APP_PASSCODE, PORT = 3000 } = process.env;
if (!DATABASE_URL) throw new Error("DATABASE_URL is not set");
if (!APP_PASSCODE) throw new Error("APP_PASSCODE is not set");

const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });

const FLOWERS = ["daisy", "poppy", "sunflower", "cornflower", "peony", "marigold", "tulip", "lavender"];
const POINTS = { 1: 5, 2: 10, 3: 20, 4: 35 };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chores (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  diff SMALLINT NOT NULL CHECK (diff BETWEEN 1 AND 4),
  flower TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS completions (
  id SERIAL PRIMARY KEY,
  chore_id INT REFERENCES chores(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  flower TEXT NOT NULL,
  diff SMALLINT NOT NULL,
  pts INT NOT NULL,
  done_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS completions_done_at_idx ON completions (done_at);
-- Weather and time zone at the moment a chore was done (added later, so nullable).
ALTER TABLE completions ADD COLUMN IF NOT EXISTS wx_kind TEXT;
ALTER TABLE completions ADD COLUMN IF NOT EXISTS wx_intensity SMALLINT;
ALTER TABLE completions ADD COLUMN IF NOT EXISTS wx_temp REAL;
ALTER TABLE completions ADD COLUMN IF NOT EXISTS wx_is_day BOOLEAN;
ALTER TABLE completions ADD COLUMN IF NOT EXISTS wx_place TEXT;
ALTER TABLE completions ADD COLUMN IF NOT EXISTS wx_source TEXT;
ALTER TABLE completions ADD COLUMN IF NOT EXISTS wx_observed_at TIMESTAMPTZ;
ALTER TABLE completions ADD COLUMN IF NOT EXISTS tz TEXT;
-- Small key/value store for API politeness state (pauses, MET Expires/Last-Modified, cached weather).
CREATE TABLE IF NOT EXISTS api_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const DEFAULT_CHORES = [
  ["Wipe stove surface", 2, "daisy"], ["Bring umido can in", 1, "poppy"],
  ["Bring secco bin in", 1, "cornflower"], ["Put out carta & plastica", 1, "lavender"],
  ["Wash the dishes", 2, "tulip"], ["Vacuum floors", 3, "sunflower"],
  ["Clean the bathroom", 4, "peony"], ["Change bed sheets", 3, "marigold"],
  ["Do a load of laundry", 2, "tulip"], ["Mop the floors", 3, "sunflower"],
];

async function migrate() {
  await pool.query(SCHEMA);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM chores");
  if (rows[0].n === 0) {
    for (const [name, diff, flower] of DEFAULT_CHORES) {
      await pool.query("INSERT INTO chores (name, diff, flower) VALUES ($1, $2, $3)", [name, diff, flower]);
    }
  }
}

const app = express();
app.use(express.json({ limit: "10kb" }));

// The page may only load things from this server: no Google Fonts, no CDNs, no third-party calls.
// (Weather is fetched server-side, see weather.js.)
app.use((_req, res, next) => {
  res.set("Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Content-Type-Options", "nosniff");
  next();
});
app.use("/fonts", express.static(path.join(__dirname, "public/fonts"), { maxAge: "365d", immutable: true }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (_req, res) => res.send("ok"));

// Every /api route needs the passcode in the x-passcode header.
const expected = crypto.createHash("sha256").update(APP_PASSCODE).digest();
app.use("/api", (req, res, next) => {
  const given = crypto.createHash("sha256").update(String(req.get("x-passcode") || "")).digest();
  if (!crypto.timingSafeEqual(given, expected)) return res.status(401).json({ error: "Wrong passcode" });
  next();
});

const wrap = fn => (req, res) => fn(req, res).catch(err => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server" });
});

const store = {
  async get(key) {
    const { rows } = await pool.query("SELECT value FROM api_state WHERE key = $1", [key]);
    return rows.length ? rows[0].value : null;
  },
  async set(key, value) {
    await pool.query(
      `INSERT INTO api_state (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(value)]);
  },
};

// Called only by an open, visible page. The server never fetches weather on its own.
app.get("/api/weather", wrap(async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const w = await weather.getWeather();
  res.json({ ...w, notices: [...w.notices, ...places.notices()] });
}));

// City search: runs only when the person presses Search (see places.js for the providers' rules).
app.get("/api/places", wrap(async (req, res) => {
  try { res.json(await places.search(req.query.q)); }
  catch (e) { res.status(e.status || 503).json({ error: e.message, notices: places.notices() }); }
}));

app.put("/api/location", wrap(async (req, res) => {
  const name = String(req.body.name || "").trim().slice(0, 80);
  const lat = Number(req.body.lat), lon = Number(req.body.lon);
  if (!name) return res.status(400).json({ error: "Pick a place" });
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return res.status(400).json({ error: "That place has no valid coordinates" });
  res.json(await weather.setLocation({
    name, lat, lon,
    region: String(req.body.region || "").slice(0, 80), country: String(req.body.country || "").slice(0, 80),
  }));
}));

// An IANA zone name like "Europe/Rome", or null if missing or unknown.
function validTimeZone(tz) {
  if (typeof tz !== "string" || tz.length > 64) return null;
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return tz; } catch { return null; }
}

const toEntry = r => ({ id: r.id, c: r.chore_id, n: r.name, f: r.flower, d: r.diff, p: r.pts, t: new Date(r.done_at).getTime() });
const toChore = r => ({ id: r.id, name: r.name, diff: r.diff, flower: r.flower });

app.get("/api/state", wrap(async (_req, res) => {
  const [chores, log] = await Promise.all([
    pool.query("SELECT id, name, diff, flower FROM chores ORDER BY id"),
    pool.query("SELECT * FROM completions ORDER BY done_at, id"),
  ]);
  const entries = log.rows.map(toEntry);
  res.json({ chores: chores.rows.map(toChore), log: entries, pts: entries.reduce((s, e) => s + e.p, 0) });
}));

app.post("/api/completions", wrap(async (req, res) => {
  const id = Number(req.body.choreId);
  const tz = validTimeZone(req.body.tz);
  const w = weather.snapshot(); // already-fetched weather only; logging a chore never calls a weather service
  const { rows } = await pool.query(
    `INSERT INTO completions (chore_id, name, flower, diff, pts,
                              wx_kind, wx_intensity, wx_temp, wx_is_day, wx_place, wx_source, wx_observed_at, tz)
     SELECT id, name, flower, diff,
            CASE diff WHEN 1 THEN 5 WHEN 2 THEN 10 WHEN 3 THEN 20 ELSE 35 END,
            $2, $3, $4, $5, $6, $7, to_timestamp($8::double precision / 1000), $9
     FROM chores WHERE id = $1 RETURNING *`,
    [id, w?.kind ?? null, w?.intensity ?? null, w?.temp ?? null, w?.isDay ?? null,
     w?.place ?? null, w?.source ?? null, w?.fetchedAt ?? null, tz]);
  if (!rows.length) return res.status(404).json({ error: "That chore no longer exists" });
  res.status(201).json(toEntry(rows[0]));
}));

app.delete("/api/completions/:id", wrap(async (req, res) => {
  await pool.query("DELETE FROM completions WHERE id = $1", [Number(req.params.id)]);
  res.status(204).end();
}));

// Returns the cleaned chore fields, or an error message to send back.
function readChore(body) {
  const name = String(body.name || "").trim().slice(0, 60);
  const diff = Number(body.diff);
  const flower = String(body.flower || "");
  if (!name) return { error: "Give the chore a name" };
  if (!POINTS[diff]) return { error: "Pick a difficulty" };
  if (!FLOWERS.includes(flower)) return { error: "Pick a flower" };
  return { name, diff, flower };
}

app.post("/api/chores", wrap(async (req, res) => {
  const c = readChore(req.body);
  if (c.error) return res.status(400).json(c);
  const { rows } = await pool.query(
    "INSERT INTO chores (name, diff, flower) VALUES ($1, $2, $3) RETURNING id, name, diff, flower", [c.name, c.diff, c.flower]);
  res.status(201).json(toChore(rows[0]));
}));

// Editing a chore changes future completions only; past flowers keep the name, flower and points they were logged with.
app.put("/api/chores/:id", wrap(async (req, res) => {
  const c = readChore(req.body);
  if (c.error) return res.status(400).json(c);
  const { rows } = await pool.query(
    "UPDATE chores SET name = $1, diff = $2, flower = $3 WHERE id = $4 RETURNING id, name, diff, flower",
    [c.name, c.diff, c.flower, Number(req.params.id)]);
  if (!rows.length) return res.status(404).json({ error: "That chore no longer exists" });
  res.json(toChore(rows[0]));
}));

app.delete("/api/chores/:id", wrap(async (req, res) => {
  await pool.query("DELETE FROM chores WHERE id = $1", [Number(req.params.id)]);
  res.status(204).end();
}));

const services = createServices(store);
migrate()
  .then(() => services.load([...weather.SERVICES, ...places.SERVICES]))
  .then(() => weather.init(store, services))
  .then(() => places.init(store, services, weather.USER_AGENT))
  .then(() => app.listen(PORT, () => console.log(`Chore Garden listening on ${PORT}`)))
  .catch(err => { console.error("Migration failed", err); process.exit(1); });
