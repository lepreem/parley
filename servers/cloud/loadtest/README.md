# Load testing

k6 against the whole cloud backend (the API, which also transcribes, Postgres,
Storage, RabbitMQ), with every paid service swapped for a stand-in on
this machine. A run costs nothing: no OpenRouter, Deepgram, Supabase
or WorkOS account is touched, and the API keys are fake, so a call that
escaped to a real provider would get a 401 rather than a bill.

Needs only Docker. k6 runs in a container too.

## Running it

From this directory:

```sh
docker compose up -d --build --wait     # build and start the stack (first time: a few minutes)
docker compose run --rm --no-deps k6 run /scripts/load.js -e PROFILE=smoke
docker compose down -v                  # stop, and drop the data
```

Start with `smoke`. It's two users for a minute and a half and should pass every
threshold. Then:

| PROFILE  | Shape                            | For                               |
| -------- | -------------------------------- | --------------------------------- |
| `smoke`  | 2 users, 1.5 min                 | the setup works                   |
| `load`   | up to 50 users, held 5 min       | a normal busy day                 |
| `stress` | 100 → 200 → 400 users, in steps  | finding what breaks first         |
| `spike`  | 20 → 300 users in 20 s, and back | a sudden rush                     |
| `soak`   | 50 users for 45 min              | leaks, and anything that piles up |

Other knobs, as `-e NAME=value` after the script:

- `AUDIO_SHARE`: fraction of sessions that upload audio and chat about its transcript (default `0.3`).
- `AUDIO_KB`: size of each upload (default `256`).
- `TABS`: idle tabs holding `GET /events` open (default depends on the profile).

To keep a run's numbers, add `--summary-export /results/<name>.json`; it lands
in `results/` here (gitignored).

The API is also on `localhost:3101` and the stand-ins on `localhost:4100`,
off the dev ports, for poking at by hand.

### Making the stand-ins slower or faster

They wait as long as the real service roughly would. Set these when starting
the stack (`CHAT_TOKENS=300 docker compose up -d mocks`):

| Variable                 | Default | What it is                         |
| ------------------------ | ------- | ---------------------------------- |
| `CHAT_FIRST_TOKEN_MS`    | 800     | before a reply's first token       |
| `CHAT_TOKEN_INTERVAL_MS` | 30      | between tokens                     |
| `CHAT_TOKENS`            | 150     | tokens per reply                   |
| `TITLE_MS`               | 600     | generating a title                 |
| `TRANSCRIBE_MS`          | 5000    | transcribing, after downloading it |

`curl localhost:4100/loadtest/stats` shows how many calls each stand-in has
answered. After a smoke run every service should have some, which is how you
know nothing went elsewhere. `transcriptions.peak` is the most transcriptions
that ran at once, which the API caps at 40 to stay under Deepgram's 50.

### Rate limits

The API multiplies every limit by `RATE_LIMIT_MULTIPLIER`, 1000 here, so k6
isn't measuring 429s. To check the real limits are enforced:
`RATE_LIMIT_MULTIPLIER=1 docker compose up -d api`.

## What it stands in for

| Service    | Stand-in                                                              | How the app is pointed at it   |
| ---------- | --------------------------------------------------------------------- | ------------------------------ |
| OpenRouter | `mocks/server.ts`: catalog, streamed chat, titles                     | `OPENROUTER_BASE_URL`          |
| Deepgram   | `mocks/server.ts`: catalog, transcription (downloads the audio first) | `DEEPGRAM_BASE_URL`            |
| WorkOS     | `mocks/server.ts`: signing keys, plus tokens for made-up users        | `WORKOS_API_BASE_URL`          |
| Supabase   | Supabase's own Postgres and Storage images                            | `DATABASE_URL`, `SUPABASE_URL` |
| RabbitMQ   | RabbitMQ                                                              | `MQ_URL`                       |

Each override is read in the one place its client is built, and
`backend/src/env.ts` refuses all of them when `NODE_ENV=production`, so none of this
can reach a deploy. That's also why the stack runs the production image with
`NODE_ENV=development`.

### Sign-in

k6 can't sign in through WorkOS, and one shared account would put every
virtual user in one user's rate limits, conversation list and event streams.
So the stand-in acts as WorkOS: it publishes a signing key as WorkOS's, and
signs a session token for each made-up user (`loadtest-user-1` …). The API
checks those tokens exactly as it checks real ones. `seed-users` inserts the
same users into Postgres. For more than 1000 virtual users, start the stack
with `LOADTEST_USERS=<n>`.

Sign-in, refresh and logout themselves aren't exercised: they're calls to
WorkOS, and rare next to everything else.

## What the numbers mean

Besides k6's own metrics:

- `chat_ready`: from sending a message to the reply starting to stream, which is the
  turn's claims and database reads.
- `chat_overhead`: a whole reply, less the time the stand-in model spends on it, which is
  everything the backend adds.
- `transcription_time`: from confirming an upload to its transcript being
  stored, including queueing and the stand-in's `TRANSCRIBE_MS`.
- The API transcribes up to 40 files at once, about 480 a minute at the
  default `TRANSCRIBE_MS`. Past that, uploads wait in the queue and
  `transcription_time` climbs.
- `GET /events` requests always "fail": k6 can't read a stream, so each open
  tab's request waits out its timeout. Only the `users` scenario counts toward
  the failure threshold.

It measures the backend, not the providers. OpenRouter's and Deepgram's own
speed and rate limits aren't in it, and neither is Supabase's pooler: the API
talks to Postgres directly. k6 and the stack also share this machine, so
compare runs with each other rather than with production.

YouTube uploads are left out: each would spend a real Supadata credit.
