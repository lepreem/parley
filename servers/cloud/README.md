# Cloud server

The hosted Parley: a Hono API in `backend/`, which also transcribes and
fetches YouTube captions through RabbitMQ queues, with Postgres and storage on
Supabase. `backend/ARCHITECTURE.md` explains how it
fits together; `deploy/README.md` covers the VPS.

## Develop

Secrets come from Doppler. Put a read-only service token for the `parley` dev
config in `servers/cloud/.env` as `DOPPLER_TOKEN=…` (see `.env.example`).
Then, from the repo root:

```sh
npm run dev     # the API on :3001, the client on :5173
npm run stack   # or: the production topology in Docker (compose.yaml)
```

Open <http://localhost:5173>. The API's debugger listens on 9229: add
`127.0.0.1:9229` in `chrome://inspect` and use `debugger;` statements.

In `backend/`: `npm test`, `npm run typecheck`, `npm run lint`. A schema
change needs `npm run db:generate` too (see ARCHITECTURE.md).
