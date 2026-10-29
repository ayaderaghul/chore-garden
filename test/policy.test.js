// Run: node test/policy.test.js — checks the per-service pause rules and MET caching with a fake clock and fake network.
const assert = require("assert");
let NOW = Date.UTC(2026, 9, 29, 10, 0, 0);
Date.now = () => NOW;
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
console.warn = console.error = () => {};

const db = new Map();
const store = { async get(k) { return db.has(k) ? JSON.parse(db.get(k)) : null; }, async set(k, v) { db.set(k, JSON.stringify(v)); } };
const calls = [];
let reply = () => { throw new Error("no reply set"); };
const headers = h => ({ get: k => h[k.toLowerCase()] ?? null });
const R = (status, body = "", h = {}) => ({ ok: status >= 200 && status < 300, status, headers: headers(h), text: async () => body, json: async () => JSON.parse(body) });
global.fetch = async (url, opts) => { calls.push({ url, h: opts.headers }); return reply(url, opts); };

const { createServices } = require("../services");
const fresh = () => { const s = createServices(store); return s; };
const pausedFor = (svc, name) => svc._state(name).pausedUntil - NOW;

(async () => {
  let s = fresh(); await s.load(["A"]);

  // 400 / 404: no pause
  reply = () => R(404); await assert.rejects(s.call("A", "u"));
  assert.strictEqual(s._state("A").pausedUntil, 0); console.log("ok 404 does not pause");

  // daily quota -> just after midnight UTC
  reply = () => R(429, '{"error":true,"reason":"Daily API request limit exceeded. Please try again tomorrow."}');
  await assert.rejects(s.call("A", "u"));
  assert.strictEqual(s._state("A").pausedUntil, Date.UTC(2026, 9, 30, 0, 1)); console.log("ok daily limit pauses until 00:01 UTC");
  const before = calls.length; await assert.rejects(s.call("A", "u")); assert.strictEqual(calls.length, before); console.log("ok paused service makes no request");
  NOW = Date.UTC(2026, 9, 30, 0, 2);

  // Retry-After seconds, and capped at a day
  reply = () => R(503, "", { "retry-after": "120" }); await assert.rejects(s.call("A", "u"));
  assert.strictEqual(pausedFor(s, "A"), 120e3); console.log("ok Retry-After 120s respected");
  NOW += 121e3;
  reply = () => R(429, "", { "retry-after": String(5 * 86400) }); await assert.rejects(s.call("A", "u"));
  assert.strictEqual(pausedFor(s, "A"), DAY); console.log("ok Retry-After capped at 1 day");
  NOW += DAY + 1;

  // success clears; then 5xx / timeout back off 1,2,4,...,60
  reply = () => R(200, "{}"); await s.call("A", "u"); assert.strictEqual(s._state("A").failures, 0);
  const waits = [];
  for (let i = 0; i < 8; i++) {
    reply = i % 2 ? () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; } : () => R(502);
    await assert.rejects(s.call("A", "u")); waits.push(pausedFor(s, "A") / MIN); NOW += pausedFor(s, "A") + 1;
  }
  assert.deepStrictEqual(waits, [1, 2, 4, 8, 16, 32, 60, 60]); console.log("ok backoff", waits.join(","), "minutes");
  reply = () => R(200, "{}"); await s.call("A", "u");

  // 403: 1 hour, then 1 day, then stop
  reply = () => R(403);
  await assert.rejects(s.call("A", "u"), /you are blocked/); assert.strictEqual(pausedFor(s, "A"), HOUR);
  assert.deepStrictEqual(s.notices(["A"]), [{ service: "A", message: "you are blocked" }]);
  NOW += HOUR + 1; await assert.rejects(s.call("A", "u"), /you are blocked/); assert.strictEqual(pausedFor(s, "A"), DAY);
  NOW += DAY + 1; await assert.rejects(s.call("A", "u"), /you are blocked/); assert.strictEqual(s._state("A").stopped, true);
  NOW += 30 * DAY; const n = calls.length; await assert.rejects(s.call("A", "u")); assert.strictEqual(calls.length, n);
  console.log("ok 403 -> 1h -> 1d -> stopped; notice says 'you are blocked'");

  // restart: state survives
  const s2 = fresh(); await s2.load(["A"]); assert.strictEqual(s2._state("A").stopped, true); console.log("ok pause state survives a restart");

  // ---- weather: Open-Meteo daily quota -> MET fallback; MET Expires / If-Modified-Since persisted
  db.clear(); calls.length = 0; NOW = Date.UTC(2026, 9, 29, 10, 0, 0);
  delete require.cache[require.resolve("../weather")];
  let weather = require("../weather"); await weather.init(store);
  const metBody = JSON.stringify({ properties: { timeseries: [{ time: new Date(NOW - 600e3).toISOString(), data: { instant: { details: { air_temperature: 13.6 } }, next_1_hours: { summary: { symbol_code: "partlycloudy_day" } } } }] } });
  reply = url => url.includes("open-meteo")
    ? R(429, '{"reason":"Daily API request limit exceeded"}')
    : R(200, metBody, { expires: new Date(NOW + 30 * MIN).toUTCString(), "last-modified": "Thu, 29 Oct 2026 09:40:00 GMT" });
  let r = await weather.getWeather();
  assert.strictEqual(r.weather.source, "MET Norway"); assert.strictEqual(r.weather.kind, "partly");
  assert.ok(calls.some(c => c.url.includes("lat=45.6715&lon=11.9274")), "4-decimal coordinates");
  assert.match(calls.find(c => c.url.includes("met.no")).h["User-Agent"], /^chore-garden\/\S+ \(https:\/\/github\.com\/ayaderaghul\/chore-garden\)$/);
  console.log("ok Open-Meteo daily limit -> MET Norway fallback, UA + 4-decimal coords");

  // restart before Expires: no MET request at all
  delete require.cache[require.resolve("../weather")]; weather = require("../weather"); await weather.init(store);
  NOW += 16 * MIN; calls.length = 0;
  r = await weather.getWeather();
  assert.strictEqual(calls.filter(c => c.url.includes("met.no")).length, 0); assert.strictEqual(calls.filter(c => c.url.includes("open-meteo")).length, 0);
  assert.strictEqual(r.weather.source, "MET Norway");
  console.log("ok after restart: Open-Meteo still paused, MET not called before Expires");

  // after Expires: If-Modified-Since sent; 304 keeps the stored forecast
  NOW += 20 * MIN; calls.length = 0;
  reply = url => url.includes("open-meteo") ? R(500) : R(304, "", { expires: new Date(NOW + 30 * MIN).toUTCString() });
  r = await weather.getWeather();
  const metCall = calls.find(c => c.url.includes("met.no"));
  assert.strictEqual(metCall.h["If-Modified-Since"], "Thu, 29 Oct 2026 09:40:00 GMT");
  assert.strictEqual(r.weather.kind, "partly");
  assert.strictEqual(JSON.parse(db.get("met:locationforecast")).expires, NOW + 30 * MIN);
  console.log("ok If-Modified-Since sent after Expires; 304 keeps the forecast; new Expires saved");
  console.log("\nall policy tests passed");
})().catch(e => { console.log("FAIL", e); process.exit(1); });
