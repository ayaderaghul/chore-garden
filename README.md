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
| `WEATHER_LAT`, `WEATHER_LON` | Where the garden's weather comes from (default: Castelfranco Veneto, 45.6715, 11.9274) |
| `WEATHER_PLACE` | Place name shown under the garden |
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

## Weather and butterflies

The garden sky follows the real weather: sun or moon and stars, drifting clouds, rain, snow, fog and lightning. On dry daytime weather a butterfly sometimes flies through and stops on a flower.

### Public APIs called

| Service | Used for | Terms we follow |
| --- | --- | --- |
| [Open-Meteo](https://open-meteo.com/en/terms) forecast | Current weather (main source) | Non-commercial, under 10,000 calls/day. Results cached 15 min in the database (at most ~96 calls/day). Credited under the garden (CC BY 4.0). |
| [MET Norway](https://api.met.no/doc/TermsOfService) Locationforecast 2.0 | Fallback | `User-Agent` names the app and a contact; coordinates rounded to 4 decimals; no request before `Expires`; `If-Modified-Since` with the stored `Last-Modified`. `Expires`, `Last-Modified` and the forecast are saved in the database, so they survive a restart. Credited under the garden (CC BY 4.0). |

Nothing else: no geocoding or map services, and no Google Fonts.

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
DELETE FROM api_state WHERE key = 'service:MET Norway';   -- or 'service:Open-Meteo'
```

Tests for these rules: `node test/policy.test.js`.

## Fonts

Bagel Fat One and Outfit are served from `public/fonts` (SIL Open Font License, licenses included). There are no requests to Google Fonts; a `Content-Security-Policy` header only allows the page to load from this server.
