# Taskies, Voice Relay

A tiny invite-gated **WebSocket proxy** in front of the **Gemini Live API** for the
exclusive ("Pro voice") build of Taskies. Gemini Live has a **free tier**, which
makes it ideal for testing.

**Why it exists:** the real `GEMINI_API_KEY` must never ship inside the distributed
`.exe` (it could be extracted by decompiling). Instead it lives only here. The app opens a
WebSocket to this relay with its **invite code**; the relay validates the code, opens its
own WebSocket to Gemini (authenticated server-side with the real key), and bridges frames
both ways. The app speaks the normal Gemini Live protocol and never sees the key.

```
app ──(WS /live?code=INVITE)──▶ relay ──(your secret key)──▶ Gemini Live (wss)
app ◀═════════ audio/JSON frames bridged both ways ═════════▶
```

Get a free API key at https://aistudio.google.com/apikey.

## Run locally

```bash
cd voice-relay
npm install
cp .env.example .env          # fill in GEMINI_API_KEY
cp codes.example.json codes.json
npm start
```

Test it:

```bash
curl -s localhost:8787/health
curl -s -X POST localhost:8787/session \
  -H 'content-type: application/json' \
  -d '{"code":"AGENT-ALPHA-7Q2K","character":"jazz"}'
# -> { "model": "gemini-...", "voice": "Aoede", "wsUrl": "ws://localhost:8787/live?code=AGENT-ALPHA-7Q2K" }
# The app then opens that wsUrl and speaks the Gemini Live protocol; the relay bridges to Google.
```

## Managing access (no redeploy needed)

`codes.json` is re-read on every request:

- **Grant access:** add `"NEW-CODE": { "note": "for X", "active": true }`.
- **Revoke instantly:** set that code's `"active": false`.

Codes are case-insensitive and whitespace-trimmed.

## Deploy

Any host that runs Node 18+ works. Set the env vars from `.env.example` in the host's
dashboard (do **not** upload `.env`). Examples:

- **Render / Railway:** new Web Service → build `npm install` → start `npm start`.
- **Fly.io:** `fly launch` then `fly secrets set GEMINI_API_KEY=... INVITE_CODES=...`.

> On hosts where you can't keep a writable `codes.json`, manage codes via the
> `INVITE_CODES` env var instead (comma-separated), or point the loader at a small DB.

## Endpoints

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET  | `/health` |, | `{ ok: true }` |
| POST | `/session` | `{ code, character }` | `{ model, voice, wsUrl }` |
| POST | `/verify`  | `{ code }` | `{ ok, downloadUrl }` (website gate) |
| WS   | `/live`    | `?code=INVITE` | bridged Gemini Live stream |
| POST | `/generate` | headers `x-invite-code`, `x-client-id`; `{ model, request }` | Gemini's `generateContent` answer, on this key (PC tasks, when the user's own key is refused); 429 `RELAY_CAP` past the daily caps |
| POST | `/music`   | `{ code, title, styles, sections: [{ name, lines, seconds }] }` | the special-day song as `audio/mpeg` (ElevenLabs Music) |

`character`: `"jazz"` = Hope (voice `Aoede`), anything else = Josh (voice `Charon`).

## Config (env)

See [.env.example](.env.example). Key knobs: `GEMINI_API_KEY`, `LIVE_MODEL`,
`VOICE_JOSH`, `VOICE_HOPE` (Gemini voices: Aoede, Charon, Kore, Puck…),
`EXCLUSIVE_DOWNLOAD_URL`, `ALLOWED_ORIGINS`, `TOKEN_TTL_SECONDS`.
`/generate` caps: `GENERATE_PER_CLIENT_DAY` (default 300 requests per install per UTC day, about 20 PC
tasks), `GENERATE_TOTAL_DAY` (default 3000 for everyone), `GENERATE_MODELS` (the models it forwards).

Special-day songs (`/music`): `ELEVENLABS_API_KEY` (unset = the endpoint answers 503 and the app
skips the song), `MUSIC_MODEL` (`music_v1` default, or `music_v2`), `MUSIC_DAILY_CAP` (songs a day
for everyone together, default 2), `MUSIC_PER_IP_DAY` (default 3), `MUSIC_MAX_SECONDS` (default
60). Every song is paid for by the key's ElevenLabs account; give the key Music access only and a
credit limit. Lyrics are never logged.
