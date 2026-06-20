// ─────────────────────────────────────────────────────────────────────────────
// lil agents — Voice Relay
//
// A tiny, invite-gated WebSocket PROXY in front of Google's Gemini Live API for the
// exclusive ("Pro voice") build of the app. The whole point:
//
//   • The real GEMINI_API_KEY lives ONLY here, on a server you control. It is
//     never shipped inside the distributed .exe, so it can't be extracted by
//     decompiling the app.
//   • The app opens a WebSocket to THIS relay at /live?code=INVITE_CODE. The relay
//     checks the code, opens its own WebSocket to Gemini (authenticated with the real
//     key, server-side), and bridges audio/JSON frames between the two — transparently,
//     so the app speaks the normal Gemini Live protocol and never sees the key.
//   • Revoke anyone instantly by flipping their code to "active": false in
//     codes.json (hot-reloaded every request — no restart/redeploy needed).
//
// Deploy anywhere that runs Node 18+ (Render, Fly.io, Railway, a small VM).
// See README.md.
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config (all via env so nothing secret is committed) ──────────────────────
// Uses Google's Gemini Live API (it has a genuinely free tier — good for testing).
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT           = process.env.PORT || 8787;
// Live model + per-character prebuilt voices. The client sets the voice in its setup
// message; these are just the defaults the relay reports. The native-audio model gives
// the most natural, emotional voice.
const MODEL        = process.env.LIVE_MODEL || 'gemini-3.1-flash-live-preview';
const VOICE_JOSH   = process.env.VOICE_JOSH || 'Charon';  // calm / deeper
const VOICE_HOPE   = process.env.VOICE_HOPE || 'Aoede';   // bright / warmer

if (!GEMINI_API_KEY) {
  console.error('FATAL: GEMINI_API_KEY is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// ── Invite codes ─────────────────────────────────────────────────────────────
// codes.json is re-read on every request so you can grant/revoke access by simply
// editing the file — no redeploy. Shape:
//   { "codes": { "ABCD-1234": { "note": "for Riya", "active": true } } }
// Optionally seed from the INVITE_CODES env var (comma-separated) for quick tests.
function loadCodes() {
  const map = new Map();
  try {
    const raw = JSON.parse(readFileSync(join(__dirname, 'codes.json'), 'utf8'));
    for (const [code, meta] of Object.entries(raw.codes || {})) {
      map.set(normalize(code), { active: meta.active !== false, note: meta.note || '' });
    }
  } catch {
    /* no codes.json yet — fall back to env only */
  }
  for (const code of (process.env.INVITE_CODES || '').split(',')) {
    const c = normalize(code);
    if (c) map.set(c, { active: true, note: 'env' });
  }
  return map;
}

const normalize = (s) => String(s || '').trim().toUpperCase();

function checkCode(code) {
  const entry = loadCodes().get(normalize(code));
  if (!entry) return { ok: false, reason: 'unknown code' };
  if (!entry.active) return { ok: false, reason: 'code revoked' };
  return { ok: true, note: entry.note };
}

// ── App ──────────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1); // correct client IP behind a host's proxy (for rate limiting)
app.use(express.json({ limit: '8kb' }));

// CORS for the website's /verify call from the browser. The app's /session call is a
// native HTTP client (no Origin header), so this only gates browser origins.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Block brute-forcing invite codes: 30 attempts / 5 min / IP.
const limiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many attempts, slow down' },
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// POST /verify  { code }  ->  { ok, downloadUrl }
// Used by the website's invite gate to check a code and reveal the exclusive build's
// download link. No cost — it only validates the code.
app.post('/verify', limiter, (req, res) => {
  const verdict = checkCode(req.body?.code);
  if (!verdict.ok) {
    console.log(`[verify] denied (${verdict.reason}) ip=${req.ip}`);
    return res.status(403).json({ ok: false, error: verdict.reason });
  }
  const downloadUrl = process.env.EXCLUSIVE_DOWNLOAD_URL || '';
  if (!downloadUrl) return res.status(500).json({ ok: false, error: 'download not configured' });
  console.log(`[verify] granted (${verdict.note}) ip=${req.ip}`);
  return res.json({ ok: true, downloadUrl });
});

// POST /session  { code, character }  ->  { model, voice, wsUrl }
// Validates the code and hands back the relay's own WebSocket URL (with the code) that
// the app connects to. The app then speaks the normal Gemini Live protocol over it; the
// relay bridges to Google with the real key (see the /live proxy below).
app.post('/session', limiter, (req, res) => {
  const { code, character } = req.body || {};

  const verdict = checkCode(code);
  if (!verdict.ok) {
    console.log(`[session] denied (${verdict.reason}) code=${normalize(code) || '∅'} ip=${req.ip}`);
    return res.status(403).json({ error: verdict.reason });
  }

  const voice  = character === 'jazz' ? VOICE_HOPE : VOICE_JOSH;
  const scheme = (req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')) === 'https' ? 'wss' : 'ws';
  const host   = req.headers.host;
  const wsUrl  = `${scheme}://${host}/live?code=${encodeURIComponent(normalize(code))}`;

  console.log(`[session] granted code=${normalize(code)} (${verdict.note}) char=${character || 'bruce'} ip=${req.ip}`);
  return res.json({ model: MODEL, voice, wsUrl });
});

// ── Spotify resolver: "play X" → the top track, so the app can actually PLAY it ──
// The app opens `spotify:track:<id>` (which the desktop client starts playing) instead of
// just `spotify:search:<q>` (which only opens a search page). We resolve the query here with
// Spotify's Client-Credentials flow so the app never holds Spotify secrets. Configure with
// SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET (a free app at developer.spotify.com). If unset,
// the endpoint returns 503 and the app gracefully falls back to opening Spotify search.
let _spToken = { value: null, expiresAt: 0 };
async function spotifyAppToken() {
  const id = process.env.SPOTIFY_CLIENT_ID, secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (_spToken.value && Date.now() < _spToken.expiresAt) return _spToken.value;
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) return null;
  const j = await r.json();
  _spToken = { value: j.access_token, expiresAt: Date.now() + Math.max(0, (j.expires_in || 3600) - 60) * 1000 };
  return _spToken.value;
}

// GET /spotify?code=INVITE&q=QUERY  ->  { id, uri, name, artist }
app.get('/spotify', limiter, async (req, res) => {
  const verdict = checkCode(req.query.code);
  if (!verdict.ok) return res.status(403).json({ error: verdict.reason });
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'no query' });
  const tok = await spotifyAppToken();
  if (!tok) return res.status(503).json({ error: 'spotify not configured' });
  try {
    const r = await fetch(
      `https://api.spotify.com/v1/search?type=track&limit=1&q=${encodeURIComponent(q)}`,
      { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) return res.status(502).json({ error: `spotify search ${r.status}` });
    const j = await r.json();
    const t = j.tracks?.items?.[0];
    if (!t) return res.status(404).json({ error: 'no track found' });
    const artist = (t.artists || []).map((a) => a.name).join(', ');
    console.log(`[spotify] "${q}" -> ${t.name} — ${artist}`);
    return res.json({ id: t.id, uri: t.uri, name: t.name, artist });
  } catch (e) {
    return res.status(502).json({ error: 'spotify error' });
  }
});

// Resolve a query to the top YouTube video (keyless — parses the results page). Opening
// the resulting watch URL autoplays the video in the browser, so this is the universal
// "actually play it" path (no API key, no Premium, works for everyone).
async function youtubeTop(q) {
  const r = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=en`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!r.ok) return null;
  const html = await r.text();
  const idm = html.match(/"videoId":"([\w-]{11})"/);
  if (!idm) return null;
  const id = idm[1];
  let label = '';
  const tm = html.match(new RegExp(`"videoId":"${id}"[\\s\\S]{0,800}?"title":\\{"runs":\\[\\{"text":"((?:[^"\\\\]|\\\\.)*)"`));
  if (tm) { try { label = JSON.parse('"' + tm[1] + '"'); } catch { label = tm[1]; } }
  return { url: `https://www.youtube.com/watch?v=${id}`, label };
}

// GET /play?code=INVITE&q=QUERY  ->  { spotify:{id,label}|null, youtube:{url,label}|null }
// The app PLAYS the result: spotify:track:<id> if a Premium-owner Spotify match exists and
// Spotify is installed, otherwise it opens the YouTube watch URL (which autoplays).
app.get('/play', limiter, async (req, res) => {
  const verdict = checkCode(req.query.code);
  if (!verdict.ok) return res.status(403).json({ error: verdict.reason });
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'no query' });

  const out = { spotify: null, youtube: null };
  try {
    const tok = await spotifyAppToken();
    if (tok) {
      const r = await fetch(`https://api.spotify.com/v1/search?type=track&limit=1&q=${encodeURIComponent(q)}`,
        { headers: { Authorization: `Bearer ${tok}` } });
      if (r.ok) {
        const t = (await r.json()).tracks?.items?.[0];
        if (t) {
          const artist = (t.artists || []).map((a) => a.name).join(', ');
          out.spotify = { id: t.id, label: artist ? `${t.name} — ${artist}` : t.name };
        }
      } // a 403 here just means the owner isn't Premium — fall through to YouTube
    }
  } catch { /* ignore — YouTube covers it */ }
  try { out.youtube = await youtubeTop(q); } catch { /* ignore */ }

  if (!out.spotify && !out.youtube) return res.status(404).json({ error: 'nothing found' });
  console.log(`[play] "${q}" -> spotify:${out.spotify?.id || '-'} youtube:${out.youtube?.url || '-'}`);
  return res.json(out);
});

// ── /live WebSocket proxy: app <—bridge—> Gemini Live ────────────────────────
const GEMINI_WS = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let pathname, code;
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    pathname = u.pathname;
    code = u.searchParams.get('code');
  } catch { socket.destroy(); return; }

  if (pathname !== '/live') { socket.destroy(); return; }
  if (!checkCode(code).ok) {
    console.log(`[live] denied code=${normalize(code) || '∅'}`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (clientWs) => bridge(clientWs, normalize(code)));
});

// Bridges one app connection to a fresh Gemini Live connection, forwarding frames
// both ways verbatim. The app drives the protocol (setup/realtimeInput/…); the relay
// just pipes — so the key stays here and the app speaks vanilla Gemini Live.
function bridge(clientWs, code) {
  const upstream = new WebSocket(GEMINI_WS);
  const pending = [];                       // app frames that arrive before upstream is open
  let open = false;
  const stats = { up: 0, upAudio: 0, down: 0, downAudio: 0 };

  // Summarize a frame for the live terminal view (don't dump base64 audio).
  const summarize = (data, dir) => {
    let s; try { s = JSON.parse(data.toString()); } catch { return `${dir} <binary ${data.length}b>`; }
    const k = Object.keys(s).join(',');
    if (s.realtimeInput?.audio)            { stats.upAudio++;   return stats.upAudio % 50 === 1 ? `${dir} audio  (#${stats.upAudio})` : null; }
    if (s.realtimeInput?.mediaChunks)      return `${dir} ⚠ mediaChunks (DEPRECATED)`;
    if (s.setup)                           return `${dir} setup (${s.setup.model})`;
    if (s.clientContent)                   return `${dir} text-turn`;
    if (s.toolResponse)                    return `${dir} toolResponse`;
    if (s.setupComplete)                   return `${dir} setupComplete`;
    if (s.toolCall)                        return `${dir} toolCall ${s.toolCall.functionCalls?.map(f=>f.name).join(',')}`;
    if (s.serverContent) {
      const sc = s.serverContent;
      if (sc.interrupted)                  return `${dir} interrupted`;
      if (sc.inputTranscription?.text)     return `${dir} 🎤 heard: "${sc.inputTranscription.text}"`;
      if (sc.outputTranscription?.text)    return `${dir} 🔊 says:  "${sc.outputTranscription.text}"`;
      if (sc.modelTurn?.parts?.some(p=>p.inlineData)) { stats.downAudio++; return stats.downAudio % 50 === 1 ? `${dir} audio  (#${stats.downAudio})` : null; }
      if (sc.turnComplete)                 return `${dir} turnComplete`;
      return `${dir} serverContent[${Object.keys(sc).join(',')}]`;
    }
    if (s.error)                           return `${dir} ❌ error: ${JSON.stringify(s.error).slice(0,120)}`;
    return `${dir} {${k}}`;
  };
  const logFrame = (data, dir) => { const line = summarize(data, dir); if (line) console.log(`[${code}] ${line}`); };

  upstream.on('open', () => {
    open = true;
    for (const [data, isBinary] of pending) upstream.send(data, { binary: isBinary });
    pending.length = 0;
  });
  upstream.on('message', (data, isBinary) => {
    stats.down++; logFrame(data, '←');
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
  });
  upstream.on('close', (c, r) => { console.log(`[${code}] upstream closed ${c} ${String(r).slice(0,80)} | totals up=${stats.up}(audio ${stats.upAudio}) down=${stats.down}(audio ${stats.downAudio})`); try { clientWs.close(c >= 1000 && c <= 4999 ? c : 1011, String(r).slice(0, 100)); } catch {} });
  upstream.on('error', (e) => { console.error(`[${code}] upstream error`, e.message); try { clientWs.close(1011); } catch {} });

  clientWs.on('message', (data, isBinary) => {
    stats.up++; logFrame(data, '→');
    if (open && upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else pending.push([data, isBinary]);
  });
  clientWs.on('close', () => { console.log(`[${code}] app disconnected | totals up=${stats.up}(audio ${stats.upAudio}) down=${stats.down}(audio ${stats.downAudio})`); try { upstream.close(); } catch {} });
  clientWs.on('error', () => { try { upstream.close(); } catch {} });

  console.log(`[live] bridged code=${code}`);
}

server.listen(PORT, () => {
  console.log(`lil agents voice relay listening on :${PORT} (model=${MODEL})`);
});
