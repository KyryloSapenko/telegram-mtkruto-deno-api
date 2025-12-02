# Telegram-MTKRUTO Deno API

Small HTTP wrapper around the [`mtkruto`](https://deno.land/x/mtkruto) Telegram client. It lets you store multiple user sessions, send outbound messages, register simple reply triggers, and drive the official registration flow with two API calls.

Every Telegram username gets its own long-lived `mtkruto` client instance. Sessions are imported from disk on demand, incoming messages are listened to per account, and triggers are rehydrated from `triggers.json` when the API boots.

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
2. Create an empty `triggers.json` alongside it so the app can persist auto-reply rules:
	 ```json
	 {}
	 ```
3. Install dependencies on first run (Deno will auto-cache imports).
4. Consider adding both JSON files to `.gitignore` so secrets and trigger texts stay local.

## Running The Services
- `deno task dev:api` – starts the HTTP API (`src/api/server.ts`). Requires network, env, read, import, and write permissions.
- `deno task dev:telegram` – runs `src/telegram/client.ts` in watch mode, useful for debugging or manual experiments.

Both commands look for `.env` and read/write `sessions.json`, so keep them in the repo root.

## Manual Console Login
There is a helper `loginManually()` inside `src/telegram/client.ts` that prompts for phone, code, and optional 2FA password. Use it to bootstrap users before calling the HTTP API.

```powershell
deno repl -A --env-file=.env
> const { loginManually } = await import("./src/telegram/client.ts");
> await loginManually();
```

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
	- Body: `{ "username": "listener_username", "trigger": "ping", "reply": "pong" }`
	- Ensures the account is logged in, subscribes to incoming messages, and replies with `reply` whenever an incoming message text matches `trigger` exactly. Each new request upserts a rule in `triggers.json`, so duplicates are avoided and the data survives restarts. While the API boots it hydrates all stored triggers and spins up listeners for every account found in the file.
- `DELETE /trigger-message`
	- Body: `{ "username": "listener_username" }`
	- Removes every trigger associated with that account from memory and from `triggers.json`. Useful when you want to stop auto-replies for a user without touching other accounts.

All write endpoints expect that the `from`/`username` accounts already have auth strings in `sessions.json` (either created via `loginManually()` or the `/register` combo).

## Trigger lifecycle cheatsheet
- Add/update a trigger via `POST /trigger-message` (body uses `username`).
- Delete all triggers for a user via `DELETE /trigger-message`.
- Rule immediately becomes active for that Telegram account and is saved to `triggers.json`.
- On next process start the trigger is reloaded automatically and the account reconnects.
- Replies are sent only when the sender has a public username; otherwise we skip with a warning in logs.