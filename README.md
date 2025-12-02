# Telegram-MTKRUTO Deno API

Small HTTP wrapper around the [`mtkruto`](https://deno.land/x/mtkruto) Telegram client. It lets you store multiple user sessions, send outbound messages, register simple reply triggers, and drive the official registration flow with two API calls.

## Prerequisites
- [Deno](https://deno.land/manual@v1.42.1/getting_started/installation)
- Telegram API credentials (`TG_API_ID`, `TG_API_HASH`)
- `.env` file in the project root that exports those variables (the app will call `@std/dotenv` automatically)

## Initial Setup
1. Create `sessions.json` in the repository root before running anything:
	 ```json
	 {}
	 ```
	 The file is mutated at runtime to cache the auth strings per Telegram username.
2. Install dependencies on first run (Deno will auto-cache imports).

## Running The Services
- `deno task dev:api` – starts the HTTP API (`src/api/server.ts`). Requires network, env, read, import, and write permissions.
- `deno task dev:telegram` – runs `src/telegram/client.ts` in watch mode, useful for debugging or manual experiments.

Both commands look for `.env` and read/write `sessions.json`, so keep them in the repo root.

## Manual Console Login
There is a helper `loginManually()` inside `src/telegram/client.ts` that prompts for phone, code, and optional 2FA password. Use it to bootstrap users before calling the HTTP API.

On success the new auth string is stored in `sessions.json` under the Telegram username, so future API calls can reuse it.

## HTTP API
All routes live under `src/api/server.ts` (Hono). Send JSON bodies and expect JSON responses.

- `GET /health`
	- Quick readiness probe. Returns `{ "ok": true }`.
- `POST /register`
	- Body: `{ "phone": "+123456789" }`
	- Starts the first step (code request). Response: `{ ok: true, status: "code_sent" }`.
- `POST /register/confirm`
	- Body: `{ "phone": "+123", "code": "12345", "password": "optional" }`
	- Completes the login using the code (and 2FA password if necessary). Response: `{ ok: true, status: "registered" }`.
- `POST /send-to-me`
	- Body: `{ "from": "my_username", "text": "hello" }`
	- Logs in as `from` (using its saved session) and sends a DM to that same account.
- `POST /send-to-user`
	- Body: `{ "from": "sender_username", "to": "target_username", "text": "hello" }`
	- Sends a direct message from one saved account to another user.
- `POST /trigger-message`
	- Body: `{ "to": "listener_username", "trigger": "ping", "reply": "pong" }`
	- Ensures the account `to` is logged in, subscribes to incoming messages, and replies with `reply` whenever an incoming message text matches `trigger` exactly.

All write endpoints expect that the `from`/`to(in trigger)` accounts already have auth strings in `sessions.json` (either created via `loginManually()` or the `/register` combo).