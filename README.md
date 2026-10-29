# Chore Garden

Log household chores, earn points by difficulty, level up, and grow a flower for every finished task.

- **Server:** Node + Express (`server.js`), serves `public/index.html` and a small JSON API.
- **Database:** Postgres on Neon. Tables `chores` and `completions` are created on startup, and the default chores are added if the table is empty.
- **Access:** every `/api` request needs the `x-passcode` header to match `APP_PASSCODE`.

## Environment variables

| Name | What it is |
| --- | --- |
| `DATABASE_URL` | Neon connection string |
| `APP_PASSCODE` | Passcode you type once on each device |
| `WEATHER_LAT`, `WEATHER_LON`, `WEATHER_PLACE` | Starting place for the weather until one is picked in the app (default: Castelfranco Veneto) |
| `WEATHER_CONTACT` | Contact sent to MET Norway in the User-Agent (default: this repo's URL) |

## Run locally

```bash
npm install
DATABASE_URL=postgres://... APP_PASSCODE=something npm start
```

## Points

| Difficulty | Points |
| --- | --- |
| Quick | 5 |
| Easy | 10 |
| Medium | 20 |
| Hard | 35 |

## What each completion records

`completions.done_at` is the exact moment (UTC). Each completion also stores:

- `tz`: the device's time zone (e.g. `Europe/Rome`), so hour-of-day stays right when travelling. Use `done_at AT TIME ZONE tz`.
- The weather at that moment: `wx_kind`, `wx_intensity`, `wx_temp` (°C), `wx_is_day`, `wx_place`, `wx_source`, `wx_observed_at`. This comes from the weather the server already has; logging a chore never calls a weather service. It is empty when no reading from the last 3 hours exists.

Completions logged before this was added have these columns empty.

## Weather and butterflies

The garden sky follows the real weather: sun or moon and stars, drifting clouds, rain, snow, fog and lightning. On dry daytime weather a butterfly sometimes flies through and stops on a flower.

### Public APIs called

| Service | Used for | Terms we follow |
| --- | --- | --- |
| [Open-Meteo](https://open-meteo.com/en/terms) forecast | Weather (main source) | Non-commercial, under 10,000 calls/day. Results cached 15 min in the database (at most ~96 calls/day). Credited under the garden (CC BY 4.0). |
| [MET Norway](https://api.met.no/doc/TermsOfService) Locationforecast 2.0 | Weather fallback | `User-Agent` names the app and a contact; coordinates rounded to 4 decimals; no request before `Expires`; `If-Modified-Since` with the stored `Last-Modified`. `Expires`, `Last-Modified` and the forecast are saved in the database, so they survive a restart. Credited under the garden (CC BY 4.0). |
| [Open-Meteo Geocoding](https://open-meteo.com/en/docs/geocoding-api) | City search (main source) | Same terms as the forecast. Place data from GeoNames (CC BY 4.0), credited under the results. |
| [OpenStreetMap Nominatim](https://operations.osmfoundation.org/policies/nominatim/) | City search fallback | At most 1 request per second (calls are queued and spaced 1.1 s apart), identifying `User-Agent`, results cached, no search-as-you-type, "© OpenStreetMap contributors" shown under the results. |

Nothing else, and no Google Fonts.

**Choosing the place.** "Change place" under the garden searches for a city. A search runs only when you press Search, and every answer is saved for 30 days, so repeating a search makes no request. On top of each provider's own limits, the server lets at most 10 searches a minute through. Weather and MET forecasts are cached per place, so switching between cities reuses what is saved.

- **Your IP stays private.** The browser never contacts these services; the server does.
- **No fetching while the app isn't in use.** The server never polls. It only fetches when an open, visible page asks (on load, then every 30 minutes while visible).

### No bombarding when a service fails

Each service has its own pause, stored in the `api_state` table so restarts can't reset it (`services.js`):

| What happened | Pause |
| --- | --- |
| Daily quota refused (e.g. Open-Meteo 429 "Daily API request limit exceeded") | Until 00:01 UTC, when the quota resets |
| `Retry-After` header | As asked, up to 1 day |
| 403 Forbidden | Page shows "**you are blocked**". Pause 1 hour; if still 403, 1 day; if still 403, stop calling |
| 5xx, timeout, network error | 1, 2, 4, 8 … up to 60 minutes |
| 400 or 404 | No pause |

A success clears that service's pause. While a service is paused, the other one is tried, and if both are unavailable the last saved weather is shown.

To unblock a stopped service after fixing the cause, run in Neon:

```sql
DELETE FROM api_state WHERE key = 'service:MET Norway';
-- or 'service:Open-Meteo', 'service:Open-Meteo geocoding', 'service:OpenStreetMap Nominatim'
```

Tests for these rules: `node test/policy.test.js`.

## Fonts

Bagel Fat One and Outfit are served from `public/fonts` (SIL Open Font License, licenses included). There are no requests to Google Fonts; a `Content-Security-Policy` header only allows the page to load from this server.
