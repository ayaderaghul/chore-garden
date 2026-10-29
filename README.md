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

Weather is fetched **by the server** (`weather.js`), so the browser never contacts a third party:

- **Open-Meteo** is the main source. Free for non-commercial use under 10,000 calls a day, with attribution. Results are cached for 15 minutes (at most ~96 calls a day).
- **MET Norway** Locationforecast 2.0 is the fallback. Following its [terms](https://api.met.no/doc/TermsOfService): an identifying `User-Agent` with contact info, coordinates rounded to 4 decimals, no new request before the `Expires` time, `If-Modified-Since` on revalidation, and attribution.
- If both fail, the last good result is reused and the server waits 5 minutes before trying again.

Both sources are credited under the garden (CC BY 4.0).

## Fonts

Bagel Fat One and Outfit are served from `public/fonts` (SIL Open Font License, licenses included). There are no requests to Google Fonts; a `Content-Security-Policy` header only allows the page to load from this server.
