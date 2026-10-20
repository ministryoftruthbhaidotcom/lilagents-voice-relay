// ─────────────────────────────────────────────────────────────────────────────
// Taskies, Voice Relay
//
// A tiny, invite-gated WebSocket PROXY in front of Google's Gemini Live API for the
// exclusive ("Pro voice") build of the app. The whole point:
//
//   • The real GEMINI_API_KEY lives ONLY here, on a server you control. It is
//     never shipped inside the distributed .exe, so it can't be extracted by
//     decompiling the app.
//   • The app opens a WebSocket to THIS relay at /live?code=INVITE_CODE. The relay
//     checks the code, opens its own WebSocket to Gemini (authenticated with the real
//     key, server-side), and bridges audio/JSON frames between the two, transparently,
//     so the app speaks the normal Gemini Live protocol and never sees the key.
//   • Revoke anyone instantly by flipping their code to "active": false in
//     codes.json (hot-reloaded every request, no restart/redeploy needed).
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
// Uses Google's Gemini Live API (it has a genuinely free tier, good for testing).
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
// editing the file, no redeploy. Shape:
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
    /* no codes.json yet, fall back to env only */
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
// Small bodies everywhere except /generate, which carries a PC task's step (a screen look, sometimes a
// picture of it) and has its own, larger limit.
const smallJson = express.json({ limit: '8kb' });
app.use((req, res, next) => (req.path === '/generate' ? next() : smallJson(req, res, next)));

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

// `build` is bumped by hand when this file changes, so a deploy can be confirmed from outside
// (the app only cares about `ok`).
app.get('/health', (_req, res) => res.json({ ok: true, build: 8 }));

// ── The shared Gemini voice quota ─────────────────────────────────────────────────────────────
// Every user's call runs on the one GEMINI_API_KEY above. When its quota runs out, Google closes
// each new call, so voice stops for everyone at once, and nobody found out until someone
// complained. The relay notes each time that happens; GET /status tells the owner's /stats page,
// which shows a banner. Only times and a count leave here: no codes, no users, no key.
const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
const quotaHits = [];                       // times (ms) a call was refused for quota or billing, last 24 h
const billingHits = [];                     // of those, the ones refused over money, last 24 h
const startedAt = new Date().toISOString();

function isQuotaReason(text) {
  const t = String(text || '').toLowerCase();
  // Not "exceeded" alone: Google also closes with "Deadline exceeded", a timeout, not a quota.
  return t.includes('quota') || t.includes('resource_exhausted') || t.includes('resource has been exhausted')
      || /\b429\b/.test(t) || t.includes('rate limit') || isBillingReason(t);
}

// Since the key is on a paid project (prepaid credit), Google can also refuse over money: the
// credit used up, billing turned off, a payment that failed. It words that several ways, so a few
// words are looked for. Counted as a quota refusal too, so nothing that read voiceQuota changes.
function isBillingReason(text) {
  const t = String(text || '').toLowerCase();
  return t.includes('billing') || t.includes('prepay') || t.includes('credit') || t.includes('payment');
}

function noteQuotaHit(code, billing = false) {
  const now = Date.now();
  for (const hits of billing ? [quotaHits, billingHits] : [quotaHits]) {
    hits.push(now);
    while (hits.length && now - hits[0] > QUOTA_WINDOW_MS) hits.shift();
    if (hits.length > 5000) hits.splice(0, hits.length - 5000);
  }
  console.warn(`[${code}] ⚠ Gemini refused this call for ${billing ? 'billing (credit or payment)' : 'quota'} (${quotaHits.length} in the last 24 h)`);
}

// ── Call counts, for the owner's daily status email ──────────────────────────────────────────
// How many calls, how long, how many at once, and how many Google ended or refused: the load on
// the one shared key, which nobody could see before. Times and outcomes only: no codes, no users.
// A call that reconnects to carry on (Gemini closes each connection after about 10 minutes and the
// app resumes the same conversation) is the same call: its minutes count, it is not counted again.
const calls = [];                           // { start, end, outcome, resumed }, last 24 h
const MAX_CALLS_KEPT = 20000;

function callStarted() {
  const call = { start: Date.now(), end: 0, outcome: '', resumed: false, answered: false, sawSetup: false, appLeft: false };
  calls.push(call);
  if (calls.length > MAX_CALLS_KEPT) calls.splice(0, calls.length - MAX_CALLS_KEPT);
  return call;
}

// outcome: "ok" (ended normally), "quota" (Google refused it for quota), "dropped" (Google ended
// it with an error mid-call), "no-start" (Google never answered the call).
function callEnded(call, outcome) {
  if (call.end) return;
  call.end = Date.now();
  call.outcome = outcome;
}

function callStats(now) {
  while (calls.length && calls[0].end && now - calls[0].end > QUOTA_WINDOW_MS) calls.shift();
  const recent = calls.filter(c => !c.end || now - c.end <= QUOTA_WINDOW_MS);
  let ms = 0;
  for (const c of recent) ms += (c.end || now) - Math.max(c.start, now - QUOTA_WINDOW_MS);
  // The most at once: sweep the starts and ends in the window.
  const edges = [];
  for (const c of recent) { edges.push([Math.max(c.start, now - QUOTA_WINDOW_MS), 1]); if (c.end) edges.push([c.end, -1]); }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let at = 0, peak = 0;
  for (const [, d] of edges) { at += d; peak = Math.max(peak, at); }
  const count = o => recent.filter(c => c.outcome === o).length;
  return {
    last24h: recent.filter(c => !c.resumed).length,
    minutesLast24h: Math.round(ms / 60000),
    activeNow: recent.filter(c => !c.end).length,
    peakAtOnceLast24h: peak,
    droppedLast24h: count('dropped'),
    couldNotStartLast24h: count('no-start'),
  };
}

// Public and read-only, so any page may read it (the website's /stats does, from the browser).
app.get('/status', (_req, res) => {
  const now = Date.now();
  for (const hits of [quotaHits, billingHits])
    while (hits.length && now - hits[0] > QUOTA_WINDOW_MS) hits.shift();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    voiceQuota: {
      lastHitAt: quotaHits.length ? new Date(quotaHits[quotaHits.length - 1]).toISOString() : null,
      hitsLast24h: quotaHits.length,
      billingLast24h: billingHits.length,   // of those, refused over money (credit used up, payment failed)
    },
    calls: callStats(now),
    generate: generateStats(now),   // PC tasks' steps on the owner's key (POST /generate)
    music: musicStatus(),
    since: startedAt,               // counts start when the relay last (re)started
  });
});

// POST /verify  { code }  ->  { ok, downloadUrl }
// Used by the website's invite gate to check a code and reveal the exclusive build's
// download link. No cost, it only validates the code.
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
    console.log(`[spotify] "${q}" -> ${t.name}, ${artist}`);
    return res.json({ id: t.id, uri: t.uri, name: t.name, artist });
  } catch (e) {
    return res.status(502).json({ error: 'spotify error' });
  }
});

// Resolve a query to the top YouTube video (keyless, parses the results page). Opening
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
          out.spotify = { id: t.id, label: artist ? `${t.name}, ${artist}` : t.name };
        }
      } // a 403 here just means the owner isn't Premium, fall through to YouTube
    }
  } catch { /* ignore, YouTube covers it */ }
  try { out.youtube = await youtubeTop(q); } catch { /* ignore */ }

  if (!out.spotify && !out.youtube) return res.status(404).json({ error: 'nothing found' });
  console.log(`[play] "${q}" -> spotify:${out.spotify?.id || '-'} youtube:${out.youtube?.url || '-'}`);
  return res.json(out);
});

// ── POST /generate: PC tasks' steps on the owner's key, when the user's own key is refused ─────
// Users' Gemini keys are free ones, and a free key runs out after a few PC tasks a day (one request
// a step). The app asks with the user's key first and comes here only when Google refuses it; this
// forwards the same generateContent request with the owner's key. Each install (an anonymous random
// id, x-client-id) gets a daily share, and all of them together a daily total, so one busy user, or
// a leaked invite code, can't run up the bill. Counts are in memory: a restart starts them afresh.
//   POST /generate  headers x-invite-code, x-client-id   body { model, request }
//   -> Google's status and body as they are; 429 { error: { status: "RELAY_CAP", retryAfterSeconds } } when capped.
const GENERATE_MODELS = new Set((process.env.GENERATE_MODELS ||
  'gemini-2.5-flash,gemini-3-flash-preview,gemini-flash-latest,gemini-flash-lite-latest')
  .split(',').map((s) => s.trim()).filter(Boolean));
const GENERATE_PER_CLIENT_DAY = Number(process.env.GENERATE_PER_CLIENT_DAY || 300);   // about 20 tasks
const GENERATE_TOTAL_DAY      = Number(process.env.GENERATE_TOTAL_DAY || 3000);
// Only what a PC task's step sends; anything else (cached content, other endpoints) is refused.
const GENERATE_FIELDS = new Set(['contents', 'systemInstruction', 'tools', 'toolConfig', 'generationConfig']);
// GEMINI_REST_URL is for the relay's tests only (a stand-in Gemini on localhost); never set it on Render.
const GEMINI_REST = process.env.GEMINI_REST_URL || 'https://generativelanguage.googleapis.com/v1beta/models';

const generateUse = { day: '', total: 0, byClient: new Map(), googleRefused: 0, capped: 0 };
// Times (ms) of forwarded and capped requests, for the last-24-hours counts the 9 AM email reads (a UTC
// day is only a few hours old at 9 AM in India). At most the total cap a day, so small.
const generateTimes = [], cappedTimes = [];
function noteTime(list, now) {
  list.push(now);
  while (list.length && now - list[0] > QUOTA_WINDOW_MS) list.shift();
  if (list.length > 20000) list.splice(0, list.length - 20000);
}

function generateToday(now) {
  const day = new Date(now).toISOString().slice(0, 10);   // the caps are per UTC day
  if (generateUse.day !== day) {
    generateUse.day = day;
    generateUse.total = 0;
    generateUse.byClient.clear();
    generateUse.googleRefused = 0;
    generateUse.capped = 0;
  }
}

function secondsToUtcMidnight(now) {
  const d = new Date(now);
  return Math.max(60, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000));
}

function generateStats(now) {
  generateToday(now);
  for (const list of [generateTimes, cappedTimes])
    while (list.length && now - list[0] > QUOTA_WINDOW_MS) list.shift();
  return {
    requestsLast24h: generateTimes.length,
    cappedLast24h: cappedTimes.length,
    requestsToday: generateUse.total,
    installsToday: generateUse.byClient.size,
    cappedToday: generateUse.capped,
    googleRefusedToday: generateUse.googleRefused,
    perInstallCap: GENERATE_PER_CLIENT_DAY,
    totalCap: GENERATE_TOTAL_DAY,
  };
}

// A burst guard on top of the daily caps: a task asks every few seconds, never this often.
const generateBurst = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.headers['x-client-id'] || req.ip),
  message: { error: 'too many requests, slow down' },
});

app.post('/generate', generateBurst, express.json({ limit: '6mb' }), async (req, res) => {
  const verdict = checkCode(req.headers['x-invite-code']);
  if (!verdict.ok) return res.status(403).json({ error: verdict.reason });
  const client = String(req.headers['x-client-id'] || '');
  if (!/^[a-f0-9]{32}$/.test(client)) return res.status(400).json({ error: 'bad client id' });
  const { model, request } = req.body || {};
  if (typeof model !== 'string' || !GENERATE_MODELS.has(model)) return res.status(400).json({ error: 'model not offered' });
  if (!request || typeof request !== 'object' || Array.isArray(request) || !Array.isArray(request.contents))
    return res.status(400).json({ error: 'bad request' });
  if (Object.keys(request).some((k) => !GENERATE_FIELDS.has(k))) return res.status(400).json({ error: 'field not allowed' });

  const now = Date.now();
  generateToday(now);
  const mine = generateUse.byClient.get(client) || 0;
  if (mine >= GENERATE_PER_CLIENT_DAY || generateUse.total >= GENERATE_TOTAL_DAY) {
    generateUse.capped++;
    noteTime(cappedTimes, now);
    const whose = mine >= GENERATE_PER_CLIENT_DAY ? 'this install' : 'everyone';
    if (generateUse.capped === 1 || generateUse.capped % 50 === 0)
      console.warn(`[generate] daily cap reached for ${whose} (${generateUse.total} requests today, ${generateUse.capped} refused)`);
    return res.status(429).json({ error: {
      code: 429, status: 'RELAY_CAP', message: `Today's share of the relay is used up for ${whose}.`,
      retryAfterSeconds: secondsToUtcMidnight(now),
    } });
  }
  generateUse.byClient.set(client, mine + 1);
  generateUse.total++;
  noteTime(generateTimes, now);

  try {
    const r = await fetch(`${GEMINI_REST}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text();
    if (!r.ok) {
      generateUse.googleRefused++;
      console.warn(`[generate] Gemini answered ${r.status} for ${model}`);
    }
    res.status(r.status).type('application/json').send(text);
  } catch (err) {
    console.warn(`[generate] could not reach Gemini: ${err.name}`);
    res.status(502).json({ error: 'the relay could not reach Gemini' });
  }
});

// ── Special-day songs: POST /music → ElevenLabs Music, the MP3 straight back ──────────────────
// On a user's birthday (and the other special days) Taskies plays them a short song made for them.
// The app writes the lyrics on the user's PC and sends only the finished song plan here; this
// adds the ELEVENLABS_API_KEY, which never leaves the server, and returns the audio.
//
// Every song is paid for by the owner's ElevenLabs account, and every install shares one invite
// code, so the code alone proves nothing about who is asking. What bounds the bill is here: a
// strict shape (at most MUSIC_MAX_SECONDS of song), a few songs per IP a day, one at a time per
// IP, and a daily cap for everyone together. Lyrics carry the user's first name, so they are never
// logged: only counts and timings are.
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_BASE    = (process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/+$/, '');
const MUSIC_MODEL        = process.env.MUSIC_MODEL || 'music_v1';
// 2 a day for everyone together (owner, 2026-10-21): a 45 s song is about 675 ElevenLabs credits, and the
// Starter plan's 40,000 a month is about 59 songs. Songs are made up to a week ahead, so a busy day waits.
const MUSIC_DAILY_CAP    = Math.max(0, parseInt(process.env.MUSIC_DAILY_CAP || '2', 10) || 0);
const MUSIC_PER_IP_DAY   = Math.max(1, parseInt(process.env.MUSIC_PER_IP_DAY || '3', 10) || 3);
const MUSIC_MAX_SECONDS  = Math.min(120, Math.max(10, parseInt(process.env.MUSIC_MAX_SECONDS || '60', 10) || 60));
const MUSIC_TIMEOUT_MS   = 180 * 1000;
const MUSIC_MAX_INFLIGHT = 3;               // songs being made at once, for everyone together
const DAY_MS             = 24 * 60 * 60 * 1000;

// Never sung, whatever the plan says.
const MUSIC_NEGATIVE_STYLES = ['explicit lyrics', 'profanity', 'screaming', 'harsh noise'];

const musicMade   = [];                     // times (ms) a song was made, last 24 h, everyone
const musicByIp   = new Map();              // ip -> times (ms) of songs made for it, last 24 h
const musicBusyIp = new Set();              // ips with a song being made right now
let   musicInflight = 0;

function pruneTimes(times, now) {
  while (times.length && now - times[0] > DAY_MS) times.shift();
  return times;
}

function musicStatus() {
  const now = Date.now();
  pruneTimes(musicMade, now);
  return { configured: Boolean(ELEVENLABS_API_KEY), madeLast24h: musicMade.length, dailyCap: MUSIC_DAILY_CAP };
}

// Links, emails and long numbers have no place in a greeting song; the app checks this too, and
// this is the last word before anything reaches ElevenLabs.
const LINK_OR_CONTACT = /(https?:\/\/|www\.|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\d{5,})/i;
const CONTROL_CHARS   = /[\u0000-\u001f\u007f]/;

function cleanText(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > max || CONTROL_CHARS.test(s) || LINK_OR_CONTACT.test(s)) return null;
  return s;
}

// The app's song plan, checked field by field. Returns { song } or { error }.
function checkSongPlan(body) {
  const title = cleanText(body?.title, 80);
  if (!title) return { error: 'title missing or not allowed' };

  const rawStyles = Array.isArray(body?.styles) ? body.styles : [];
  if (rawStyles.length < 1 || rawStyles.length > 6) return { error: 'styles: 1 to 6 expected' };
  const styles = rawStyles.map((s) => cleanText(s, 60));
  if (styles.some((s) => !s)) return { error: 'a style is missing or not allowed' };

  const rawSections = Array.isArray(body?.sections) ? body.sections : [];
  if (rawSections.length < 1 || rawSections.length > 4) return { error: 'sections: 1 to 4 expected' };
  const sections = [];
  let total = 0;
  for (const raw of rawSections) {
    const name = cleanText(raw?.name, 40);
    if (!name) return { error: 'a section name is missing or not allowed' };
    const rawLines = Array.isArray(raw?.lines) ? raw.lines : [];
    if (rawLines.length < 1 || rawLines.length > 12) return { error: 'lines: 1 to 12 per section expected' };
    const lines = rawLines.map((l) => cleanText(l, 120));
    if (lines.some((l) => !l)) return { error: 'a lyric line is missing or not allowed' };
    const seconds = Number(raw?.seconds);
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 60) return { error: 'section seconds: 5 to 60 expected' };
    total += seconds;
    sections.push({ name, lines, seconds });
  }
  if (total > MUSIC_MAX_SECONDS) return { error: `the song is longer than ${MUSIC_MAX_SECONDS} seconds` };
  return { song: { title, styles, sections, seconds: total } };
}

// ElevenLabs' composition plan for the configured model. music_v1 takes named sections with
// their own lines; music_v2 and later take "chunks" whose text starts with the section name.
function elevenLabsBody(song) {
  if (MUSIC_MODEL === 'music_v1') {
    return {
      model_id: MUSIC_MODEL,
      composition_plan: {
        positive_global_styles: song.styles,
        negative_global_styles: MUSIC_NEGATIVE_STYLES,
        sections: song.sections.map((s) => ({
          section_name: s.name,
          positive_local_styles: [],
          negative_local_styles: [],
          duration_ms: s.seconds * 1000,
          lines: s.lines,
        })),
      },
    };
  }
  return {
    model_id: MUSIC_MODEL,
    composition_plan: {
      chunks: song.sections.map((s, i) => ({
        text: `[${s.name}]\n${s.lines.join('\n')}`,
        duration_ms: s.seconds * 1000,
        positive_styles: i === 0 ? song.styles : [],
        negative_styles: MUSIC_NEGATIVE_STYLES,
      })),
    },
  };
}

// POST /music  { code, title, styles: [..], sections: [{ name, lines: [..], seconds }] }
//   200 audio/mpeg               the song
//   400 { error }                the plan broke a rule (the app then uses its plain fallback)
//   403 { error }                bad invite code
//   429 { error, retry: false }  today's limit for this IP or for everyone; the app gives up for today
//   503 { error }                no ELEVENLABS_API_KEY, or too many songs being made right now
//   502 { error }                ElevenLabs failed; the app may try again later
app.post('/music', limiter, async (req, res) => {
  const verdict = checkCode(req.body?.code);
  if (!verdict.ok) return res.status(403).json({ error: verdict.reason });
  if (!ELEVENLABS_API_KEY) return res.status(503).json({ error: 'music not configured' });

  const plan = checkSongPlan(req.body);
  if (plan.error) {
    console.log(`[music] refused a plan: ${plan.error}`);
    return res.status(400).json({ error: plan.error });
  }

  const now = Date.now();
  pruneTimes(musicMade, now);
  const ipTimes = pruneTimes(musicByIp.get(req.ip) || [], now);
  if (musicMade.length >= MUSIC_DAILY_CAP) {
    console.warn(`[music] ⚠ daily cap reached (${musicMade.length}/${MUSIC_DAILY_CAP})`);
    return res.status(429).json({ error: 'daily limit reached', retry: false });
  }
  if (ipTimes.length >= MUSIC_PER_IP_DAY) return res.status(429).json({ error: 'daily limit for this address', retry: false });
  if (musicBusyIp.has(req.ip)) return res.status(429).json({ error: 'a song is already being made', retry: true });
  if (musicInflight >= MUSIC_MAX_INFLIGHT) return res.status(503).json({ error: 'busy, try again later' });

  // Counted before the paid call, so parallel requests can't slip past the caps; given back if
  // ElevenLabs fails, since a failed song costs nothing.
  musicMade.push(now);
  ipTimes.push(now);
  musicByIp.set(req.ip, ipTimes);
  musicBusyIp.add(req.ip);
  musicInflight++;
  const giveBack = () => {
    const a = musicMade.lastIndexOf(now); if (a >= 0) musicMade.splice(a, 1);
    const b = ipTimes.lastIndexOf(now);   if (b >= 0) ipTimes.splice(b, 1);
  };

  const started = Date.now();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), MUSIC_TIMEOUT_MS);
  try {
    const r = await fetch(`${ELEVENLABS_BASE}/v1/music?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_API_KEY },
      body: JSON.stringify(elevenLabsBody(plan.song)),
      signal: abort.signal,
    });
    if (!r.ok) {
      giveBack();
      // The status only: ElevenLabs' error body can echo the lyrics back.
      console.warn(`[music] ElevenLabs answered ${r.status} after ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return res.status(502).json({ error: `music service answered ${r.status}` });
    }
    const audio = Buffer.from(await r.arrayBuffer());
    if (audio.length < 1024) {
      giveBack();
      console.warn(`[music] ElevenLabs sent ${audio.length} bytes, not a song`);
      return res.status(502).json({ error: 'music service sent no audio' });
    }
    console.log(`[music] made a ${plan.song.seconds}s song in ${((Date.now() - started) / 1000).toFixed(1)}s, ` +
                `${Math.round(audio.length / 1024)} KB (${musicMade.length}/${MUSIC_DAILY_CAP} today)`);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(audio);
  } catch (e) {
    giveBack();
    const timedOut = e?.name === 'AbortError';
    console.warn(`[music] ${timedOut ? 'timed out' : 'failed'} after ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return res.status(502).json({ error: timedOut ? 'music service took too long' : 'music service unreachable' });
  } finally {
    clearTimeout(timer);
    musicBusyIp.delete(req.ip);
    musicInflight--;
  }
});

// ── /live WebSocket proxy: app <-bridge-> Gemini Live ────────────────────────
// GEMINI_LIVE_WS_URL is for the relay's tests only (a stand-in Gemini on localhost); never set it on Render.
const GEMINI_WS = process.env.GEMINI_LIVE_WS_URL ||
  `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

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
// just pipes, so the key stays here and the app speaks vanilla Gemini Live.
function bridge(clientWs, code) {
  const upstream = new WebSocket(GEMINI_WS);
  const call = callStarted();
  const pending = [];                       // app frames that arrive before upstream is open
  let open = false;
  const stats = { up: 0, upAudio: 0, down: 0, downAudio: 0 };

  // Audio frames are big (base64 PCM) and constant: several every second in each direction, for
  // every caller on the box. Parsing each one only to decide not to print it burned the relay's
  // CPU and added jitter to the very stream it was logging, which the caller hears as the voice
  // breaking up. Anything over this size is audio for logging purposes: counted, never parsed.
  const AUDIO_SIZE_HINT = 2048;

  // Summarize a frame for the live terminal view (don't dump base64 audio).
  const summarize = (data, dir) => {
    if (data.length > AUDIO_SIZE_HINT) {
      const up = dir === '→';
      const n = up ? ++stats.upAudio : ++stats.downAudio;
      return n % 50 === 1 ? `${dir} audio  (#${n}, ${Math.round(data.length / 1024)} KB)` : null;
    }
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
    // Only small frames are looked at, and only until Google has answered the setup.
    if (!call.answered && data.length <= AUDIO_SIZE_HINT && data.toString().includes('setupComplete')) call.answered = true;
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
  });
  upstream.on('close', (c, r) => {
    console.log(`[${code}] upstream closed ${c} ${String(r).slice(0,80)} | totals up=${stats.up}(audio ${stats.upAudio}) down=${stats.down}(audio ${stats.downAudio})`);
    const quota = c !== 1000 && isQuotaReason(r);
    if (quota) noteQuotaHit(code, isBillingReason(r));
    // The app hanging up closes this side too; only an end Google chose says anything about Google.
    callEnded(call, call.appLeft || c === 1000 ? 'ok' : quota ? 'quota' : call.answered ? 'dropped' : 'no-start');
    try { clientWs.close(c >= 1000 && c <= 4999 ? c : 1011, String(r).slice(0, 100)); } catch {}
  });
  // A quota refusal can also come before the socket opens, as an HTTP 429 ("Unexpected server
  // response: 429"). The app is told the reason too, so it can say "today's limit" in words.
  upstream.on('error', (e) => {
    console.error(`[${code}] upstream error`, e.message);
    const quota = isQuotaReason(e.message);
    if (quota) noteQuotaHit(code, isBillingReason(e.message));
    callEnded(call, call.appLeft ? 'ok' : quota ? 'quota' : call.answered ? 'dropped' : 'no-start');
    try { clientWs.close(1011, quota ? 'quota exceeded' : undefined); } catch {}
  });

  clientWs.on('message', (data, isBinary) => {
    stats.up++; logFrame(data, '→');
    // The app's first frame is its setup; one carrying a resumption handle continues an earlier call.
    if (!call.sawSetup) {
      call.sawSetup = true;
      try { call.resumed = Boolean(JSON.parse(data.toString()).setup?.sessionResumption?.handle); } catch { /* not JSON: a new call */ }
    }
    if (open && upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else pending.push([data, isBinary]);
  });
  clientWs.on('close', () => {
    console.log(`[${code}] app disconnected | totals up=${stats.up}(audio ${stats.upAudio}) down=${stats.down}(audio ${stats.downAudio})`);
    call.appLeft = true;
    callEnded(call, 'ok');
    try { upstream.close(); } catch {}
  });
  clientWs.on('error', () => { call.appLeft = true; callEnded(call, 'ok'); try { upstream.close(); } catch {} });

  console.log(`[live] bridged code=${code}`);
}

server.listen(PORT, () => {
  console.log(`Taskies voice relay listening on :${PORT} (model=${MODEL})`);
});
