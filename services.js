// Polite calls to public APIs, with a separate pause for each service after a failure.
//
// Rules (per service):
//  - Daily-quota refusal (e.g. Open-Meteo "Daily API request limit exceeded") -> pause until 00:01 UTC.
//  - Retry-After header -> wait that long, capped at 24 hours.
//  - 403 Forbidden -> "you are blocked": pause 1 hour; if still 403, pause 1 day; if still 403, stop calling.
//  - 5xx, timeouts, network errors -> back off 1, 2, 4, ... up to 60 minutes.
//  - 400 / 404 (a bad request for one place) -> no pause.
// A success clears the service's pause and failure counters.
// State is kept in the api_state table so a restart (Render free instances restart often) can't reset it.

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const TIMEOUT_MS = 8000;
const BLOCKED = "you are blocked";

class ServiceError extends Error {
  constructor(service, message, { status = null, paused = false } = {}) {
    super(`${service}: ${message}`);
    this.service = service; this.status = status; this.paused = paused;
  }
}

function createServices(store) {
  const states = new Map(); // service -> { pausedUntil, failures, blockStrikes, stopped, reason }

  const blank = () => ({ pausedUntil: 0, failures: 0, blockStrikes: 0, stopped: false, reason: null });

  async function load(names) {
    for (const name of names) states.set(name, { ...blank(), ...(await store.get("service:" + name)) });
  }
  const get = name => { if (!states.has(name)) states.set(name, blank()); return states.get(name); };
  const save = name => store.set("service:" + name, get(name));

  async function pause(name, ms, reason) {
    const st = get(name);
    st.pausedUntil = Date.now() + ms; st.reason = reason;
    await save(name);
    console.warn(`[${name}] paused until ${new Date(st.pausedUntil).toISOString()} — ${reason}`);
  }
  async function backoff(name, why) {
    const st = get(name);
    st.failures += 1;
    await pause(name, Math.min(60, 2 ** (st.failures - 1)) * MIN, `${why} (failure ${st.failures})`);
  }

  function nextUtcMidnight() {
    const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 1);
  }
  function retryAfterMs(res) {
    const h = res.headers.get("retry-after");
    if (!h) return null;
    const secs = Number(h);
    const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(h) - Date.now();
    return Number.isFinite(ms) && ms > 0 ? Math.min(ms, DAY) : null;
  }

  // Throws ServiceError if the service is paused or stopped; otherwise resolves with the Response (2xx or 304).
  async function call(name, url, headers = {}) {
    const st = get(name);
    if (st.stopped) throw new ServiceError(name, BLOCKED + " (stopped calling it)", { paused: true, status: 403 });
    if (Date.now() < st.pausedUntil) throw new ServiceError(name, `paused until ${new Date(st.pausedUntil).toISOString()}: ${st.reason}`, { paused: true });

    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      await backoff(name, e.name === "TimeoutError" ? "timed out" : `network error: ${e.message}`);
      throw new ServiceError(name, "unreachable");
    }

    if (res.ok || res.status === 304) {
      if (st.failures || st.blockStrikes || st.pausedUntil || st.reason) {
        Object.assign(st, blank());
        await save(name);
      }
      return res;
    }

    const status = res.status;
    let body = "";
    try { body = await res.text(); } catch {}

    if (status === 403) {
      st.blockStrikes += 1;
      if (st.blockStrikes >= 3) {
        st.stopped = true; st.reason = BLOCKED;
        await save(name);
        console.error(`[${name}] ${BLOCKED} — 403 three times in a row; no more calls until the block is cleared (see README).`);
      } else {
        console.error(`[${name}] ${BLOCKED} (403)`);
        await pause(name, st.blockStrikes === 1 ? HOUR : DAY, BLOCKED);
      }
      throw new ServiceError(name, BLOCKED, { status });
    }

    if (status === 429 && /daily/i.test(body)) {
      await pause(name, nextUtcMidnight() - Date.now(), "daily request limit reached");
      throw new ServiceError(name, "daily limit reached", { status });
    }
    const ra = retryAfterMs(res);
    if (ra) {
      await pause(name, ra, `asked to retry later (${status})`);
      throw new ServiceError(name, `retry later (${status})`, { status });
    }
    if (status === 429) {
      if (/hourly/i.test(body)) { const d = new Date(); await pause(name, Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1, 1) - Date.now(), "hourly request limit reached"); }
      else if (/minutely/i.test(body)) await pause(name, MIN, "per-minute request limit reached");
      else await backoff(name, "too many requests (429)");
      throw new ServiceError(name, "rate limited", { status });
    }
    if (status >= 500) {
      await backoff(name, `server error ${status}`);
      throw new ServiceError(name, `server error ${status}`, { status });
    }
    // 400, 404 and other client errors: a problem with this request, not with the service. No pause.
    throw new ServiceError(name, `request rejected (${status})`, { status });
  }

  // Short messages the page can show, e.g. "MET Norway: you are blocked".
  function notices(names) {
    const out = [];
    for (const name of names) {
      const st = get(name);
      if (st.stopped || (st.reason === BLOCKED && Date.now() < st.pausedUntil)) out.push({ service: name, message: BLOCKED });
    }
    return out;
  }

  return { load, call, notices, _state: get };
}

module.exports = { createServices, ServiceError, BLOCKED };
