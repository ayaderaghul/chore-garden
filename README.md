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
