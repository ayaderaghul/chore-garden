const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

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
  const { rows } = await pool.query(
    `INSERT INTO completions (chore_id, name, flower, diff, pts)
     SELECT id, name, flower, diff,
            CASE diff WHEN 1 THEN 5 WHEN 2 THEN 10 WHEN 3 THEN 20 ELSE 35 END
     FROM chores WHERE id = $1 RETURNING *`, [id]);
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

migrate()
  .then(() => app.listen(PORT, () => console.log(`Chore Garden listening on ${PORT}`)))
  .catch(err => { console.error("Migration failed", err); process.exit(1); });
