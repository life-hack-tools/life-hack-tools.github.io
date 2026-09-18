/**
 * lh.tools contact form Worker
 *
 * Single intake point for every "contact us" route we own. Submissions are
 * posted to a private Slack channel through an Incoming Webhook, so no email
 * address has to be published anywhere and no mail infrastructure is involved.
 *
 *   - the website form at https://lh.tools/contact/ (ja/en/vi)
 *   - the in-app support screen shipped with @life-hack-tools/support
 *
 * Endpoints
 *   GET  /config      -> { turnstileSiteKey }   (public site key, served at
 *                                                runtime so it never has to
 *                                                live in the repo)
 *   POST /submit      -> browser. Protected by Turnstile + honeypot + time trap.
 *   POST /app-submit  -> native apps. Turnstile cannot run in React Native, so
 *                        this route is gated by a per-app key instead. See the
 *                        note on X-LHT-App-Key below.
 *
 * Configuration (all set on the Worker, never committed):
 *   TURNSTILE_SITE_KEY    var     Turnstile site key (public)
 *   TURNSTILE_SECRET_KEY  secret  Turnstile secret key
 *   APP_KEYS              secret  JSON map of app slug -> key, e.g.
 *                                 {"batto":"...","instantid":"..."}
 *   SLACK_WEBHOOK_URL     secret  Slack Incoming Webhook URL. The URL itself is
 *                                 the credential: never commit it, never log it.
 *
 * Bindings (declared in wrangler.toml):
 *   APP_RATE_LIMITER      rate limit for /app-submit, keyed app:<slug>:<ip>
 *   FORM_RATE_LIMITER     rate limit for /submit,     keyed form:<ip>
 */

const ALLOWED_ORIGINS = [
  'https://lh.tools',
  'https://www.lh.tools',
  'https://life-hack-tools.github.io',
];

const MAX_BODY_BYTES = 32 * 1024;
const MIN_FILL_SECONDS = 3;

/** Must match the `period` of both [[ratelimits]] bindings in wrangler.toml. */
const RATE_LIMIT_PERIOD_SECONDS = 60;

const LIMITS = {
  name: 100,
  email: 254,
  topic: 60,
  app: 60,
  message: 5000,
  page: 300,
  meta: 60,
};

/** Apps allowed to post to /app-submit, slug -> display name. */
const APPS = {
  batto: 'Batto',
  instantid: 'InstantID',
  pitto: 'Pitto',
  peckish: 'Peckish',
  stockhome: 'StockHome',
  'mahjong-cho': 'mahjong-cho',
  'word-diary': 'WordDiary',
  mugg: 'Mugg',
  rete: 'Rete',
  'life-calendar': 'Life Calendar',
  'todo-box': 'TodoBox',
};

const APP_TOPICS = ['feedback', 'bug', 'question', 'deletion'];

/** Build/device fields posted by the app, in display order. */
const META_FIELDS = [
  'appVersion',
  'buildVersion',
  'runtimeVersion',
  'platform',
  'osVersion',
  'locale',
  'device',
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Native apps send no Origin (or a literal "null"), so this route does not
    // do any origin-based gating and never answers with CORS headers. Keeping
    // it above the CORS handling below is deliberate.
    if (url.pathname === '/app-submit') {
      if (request.method !== 'POST') return json({ ok: false, error: 'not_found' }, 404, {});
      return handleAppSubmit(request, env);
    }

    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === '/config' && request.method === 'GET') {
      return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || null }, 200, cors);
    }

    if (url.pathname === '/submit' && request.method === 'POST') {
      return handleSubmit(request, env, cors);
    }

    return json({ ok: false, error: 'not_found' }, 404, cors);
  },
};

async function handleSubmit(request, env, cors) {
  // Before anything else, and in particular before Turnstile's siteverify and
  // the Slack post, so a flood costs us no outbound calls.
  if (!(await withinRateLimit(env, 'FORM_RATE_LIMITER', `form:${clientIp(request)}`))) {
    return rateLimited(cors);
  }

  let payload;
  try {
    payload = await readJson(request);
  } catch (err) {
    return json({ ok: false, error: err.message === 'too_large' ? 'too_large' : 'bad_request' }, 400, cors);
  }

  // Honeypot: a real browser never fills this field in.
  if (str(payload.company)) {
    // Pretend everything went fine so bots do not learn anything.
    return json({ ok: true }, 200, cors);
  }

  // Time trap: instant submissions are almost always scripted.
  const elapsed = Number(payload.elapsed);
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < MIN_FILL_SECONDS) {
    return json({ ok: false, error: 'too_fast' }, 400, cors);
  }

  const fields = {
    name: clamp(str(payload.name), LIMITS.name),
    email: clamp(str(payload.email), LIMITS.email),
    topic: clamp(str(payload.topic), LIMITS.topic),
    app: clamp(str(payload.app), LIMITS.app),
    message: clamp(str(payload.message), LIMITS.message, true),
    lang: ['ja', 'en', 'vi'].includes(str(payload.lang)) ? str(payload.lang) : 'ja',
    page: clamp(str(payload.page), LIMITS.page),
  };

  if (!isEmail(fields.email)) {
    return json({ ok: false, error: 'invalid_email' }, 400, cors);
  }
  if (fields.message.length < 10) {
    return json({ ok: false, error: 'message_too_short' }, 400, cors);
  }

  const token = str(payload.turnstileToken);
  const verified = await verifyTurnstile(token, request, env);
  if (!verified) {
    return json({ ok: false, error: 'challenge_failed' }, 403, cors);
  }

  try {
    await deliver(env, buildSiteMessage(fields, request));
  } catch (err) {
    console.error('delivery failed', err && err.stack ? err.stack : err);
    return json({ ok: false, error: 'delivery_failed' }, 502, cors);
  }

  return json({ ok: true }, 200, cors);
}

/* --------------------------------------------------------------- app-submit */

/**
 * In-app feedback from the @life-hack-tools/support screen.
 *
 * Turnstile is browser-only, so this route is gated by X-LHT-App-Key instead.
 * That key ships inside the app bundle and is therefore NOT a secret — anyone
 * willing to unpack an .ipa/.apk can read it. It exists to raise the floor, not
 * to authenticate. The real abuse control is the Cloudflare rate limiting rule
 * on this path (see README); treat that rule as required, not optional.
 */
async function handleAppSubmit(request, env) {
  let payload;
  try {
    payload = await readJson(request);
  } catch (err) {
    return json({ ok: false, error: err.message === 'too_large' ? 'too_large' : 'bad_request' }, 400, {});
  }

  const app = clamp(str(payload.app), LIMITS.app).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(APPS, app)) {
    return json({ ok: false, error: 'unknown_app' }, 400, {});
  }

  // The slug is part of the bucket key, so it is only used once it has passed
  // the allowlist above — otherwise rotating made-up slugs would hand out a
  // fresh bucket per request. Still ahead of the key check and the Slack post.
  if (!(await withinRateLimit(env, 'APP_RATE_LIMITER', `app:${app}:${clientIp(request)}`))) {
    return rateLimited({});
  }

  if (!verifyAppKey(request, env, app)) {
    return json({ ok: false, error: 'unauthorized' }, 401, {});
  }

  // Optional: only present when the user wants a reply.
  const email = clamp(str(payload.email), LIMITS.email);
  if (email && !isEmail(email)) {
    return json({ ok: false, error: 'invalid_email' }, 400, {});
  }

  const message = clamp(str(payload.message), LIMITS.message, true);
  if (message.length < 10) {
    return json({ ok: false, error: 'message_too_short' }, 400, {});
  }

  const rawTopic = clamp(str(payload.topic), LIMITS.topic).toLowerCase();
  const topic = APP_TOPICS.includes(rawTopic) ? rawTopic : 'other';
  const meta = readMeta(payload.meta);

  try {
    await deliver(env, buildAppMessage({ app, topic, email, message, meta }, request));
  } catch (err) {
    console.error('delivery failed', err && err.stack ? err.stack : err);
    return json({ ok: false, error: 'delivery_failed' }, 502, {});
  }

  return json({ ok: true }, 200, {});
}

function verifyAppKey(request, env, app) {
  const provided = request.headers.get('X-LHT-App-Key') || '';
  if (!provided || !env.APP_KEYS) return false;

  let keys;
  try {
    keys = JSON.parse(env.APP_KEYS);
  } catch (err) {
    console.error('APP_KEYS is not valid JSON');
    return false;
  }
  if (!keys || typeof keys !== 'object') return false;

  const expected = keys[app];
  if (typeof expected !== 'string' || !expected) return false;

  return timingSafeEqual(provided, expected);
}

function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

function readMeta(raw) {
  const meta = {};
  if (!raw || typeof raw !== 'object') return meta;
  for (const key of META_FIELDS) {
    const value = clamp(str(raw[key]), LIMITS.meta);
    if (value) meta[key] = value;
  }
  return meta;
}

/* --------------------------------------------------------------- rate limit */

const warnedMissingLimiter = new Set();

/**
 * Workers Rate Limiting binding (limit 3 / period 60 s, see wrangler.toml).
 *
 * This is a secondary control: the app key and Turnstile are the primary ones.
 * So it fails open — if the binding is absent (local tests, or a deploy that
 * had to drop it) or the call throws, the request goes through. Counting is
 * per Cloudflare location and eventually consistent, so the limit is
 * approximate, not exact.
 */
async function withinRateLimit(env, binding, key) {
  const limiter = env[binding];
  if (!limiter) {
    if (!warnedMissingLimiter.has(binding)) {
      warnedMissingLimiter.add(binding);
      console.warn(`${binding} binding is not configured; rate limiting is off for this route`);
    }
    return true;
  }

  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch (err) {
    console.error(`${binding} failed; letting the request through`, err && err.stack ? err.stack : err);
    return true;
  }
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

/** `headers` carries CORS for /submit so the browser form can read the body. */
function rateLimited(headers) {
  return json({ ok: false, error: 'rate_limited' }, 429, {
    ...headers,
    'Retry-After': String(RATE_LIMIT_PERIOD_SECONDS),
  });
}

/* ---------------------------------------------------------------- turnstile */

async function verifyTurnstile(token, request, env) {
  if (!token || !env.TURNSTILE_SECRET_KEY) return false;

  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET_KEY);
  body.append('response', token);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) body.append('remoteip', ip);

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error('turnstile verify failed', err);
    return false;
  }
}

/* ------------------------------------------------------------------ deliver */

/**
 * Post to Slack. Fails closed: a missing/invalid webhook URL or any non-2xx
 * answer throws, and the caller turns that into `delivery_failed` so the app
 * can fall back to the website form.
 *
 * The webhook URL is the credential, so it must never end up in an error
 * message or a log line.
 */
async function deliver(env, text) {
  const url = env.SLACK_WEBHOOK_URL;
  if (!url) throw new Error('SLACK_WEBHOOK_URL is not configured');
  if (!url.startsWith('https://hooks.slack.com/')) {
    throw new Error('SLACK_WEBHOOK_URL is not a Slack incoming webhook URL');
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
    });
  } catch (err) {
    // Runtime network errors can echo the request URL; do not pass them on.
    throw new Error(`slack request failed (${(err && err.name) || 'Error'})`);
  }

  if (!res.ok) {
    // Slack answers with short codes such as "invalid_payload" or "no_service".
    const detail = (await res.text().catch(() => '')).slice(0, 100);
    throw new Error(`slack responded ${res.status}${detail ? `: ${detail}` : ''}`);
  }
}

/* ----------------------------------------------------------------- messages */

/*
 * Every value that came from a visitor or an app goes through `esc()` before it
 * reaches the message, so `<!channel>`, `<!here>`, `<@U123>` and `<url|label>`
 * arrive as literal text instead of Slack control sequences. The only raw `<`,
 * `>` or `&` in a message are the ones written in this file.
 *
 * Layout, top to bottom:
 *   1. one bold line that says where it came from, which app, what kind, which build
 *   2. the visitor's message, fenced in a quote so it cannot pass for our labels
 *   3. the reply address alone in a code block (no mailto auto-link, easy to copy)
 *   4. route-specific details, then a small footer for tracing
 */

function buildSiteMessage(fields, request) {
  const title = ['[サイト]', fields.app, fields.topic || 'other'].filter(Boolean).join(' ');

  return [
    `*${esc(title)}*`,
    '',
    quote(fields.message),
    '',
    ...replyTo(fields.email),
    `*名前*  ${esc(fields.name) || '-'}`,
    `*言語*  ${esc(fields.lang)}`,
    `*送信元ページ*  ${fields.page ? `\`${esc(fields.page)}\`` : '-'}`,
    footer(request),
  ].join('\n');
}

function buildAppMessage({ app, topic, email, message, meta }, request) {
  const title = ['[アプリ]', APPS[app], topic];
  if (meta.appVersion) title.push(`v${meta.appVersion}`);
  if (meta.platform) title.push(`(${meta.platform})`);

  const width = Math.max(...META_FIELDS.map((key) => key.length));
  const metaLines = META_FIELDS.map((key) => `${key.padEnd(width)} : ${meta[key] || '-'}`);

  return [
    `*${esc(title.join(' '))}*`,
    '',
    quote(message),
    '',
    ...replyTo(email),
    '*ビルド・端末*',
    codeBlock(metaLines.join('\n')),
    footer(request),
  ].join('\n');
}

function replyTo(email) {
  return email ? ['*返信先*', codeBlock(email)] : ['*返信先*  なし'];
}

function footer(request) {
  const ray = request.headers.get('CF-Ray') || '-';
  const country = (request.cf && request.cf.country) || '-';
  return esc(`受信 ${new Date().toISOString()} ・ 国 ${country} ・ Ray ${ray}`);
}

function quote(text) {
  return esc(text)
    .split('\n')
    .map((line) => `>${line}`)
    .join('\n');
}

function codeBlock(text) {
  return `\`\`\`\n${esc(text)}\n\`\`\``;
}

/** Slack's escaping rules for message text: exactly these three, `&` first. */
function esc(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* -------------------------------------------------------------------- utils */

async function readJson(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.includes('application/json')) throw new Error('bad_request');

  const body = await request.text();
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) throw new Error('too_large');

  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') throw new Error('bad_request');
    return parsed;
  } catch (err) {
    throw new Error('bad_request');
  }
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Strip control characters so they cannot be used to forge extra lines in the
 * message we post. Only the message body is allowed to contain newlines, and
 * they are normalised to \n first.
 */
function clamp(value, max, multiline = false) {
  const normalised = value.replace(/\r\n?/g, '\n');
  const cleaned = multiline
    // eslint-disable-next-line no-control-regex
    ? normalised.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '')
    // eslint-disable-next-line no-control-regex
    : normalised.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, max);
}

/**
 * Backticks are refused as well as the usual separators: the reply address is
 * posted inside a code block, and a backtick would let it close that block.
 */
function isEmail(value) {
  return /^[^\s@,;:<>"'`]+@[^\s@,;:<>"'`]+\.[^\s@,;:<>"'`]+$/.test(value);
}

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (isAllowedOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Local preview of the static site.
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}
