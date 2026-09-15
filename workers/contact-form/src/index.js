/**
 * lh.tools contact form Worker
 *
 * Receives submissions from https://lh.tools/contact/ (ja/en/vi) and forwards
 * them to a private inbox so that no email address has to be published on the
 * website.
 *
 * Endpoints
 *   GET  /config  -> { turnstileSiteKey }   (public site key, served at runtime
 *                                            so it never has to live in the repo)
 *   POST /submit  -> { ok: true }
 *
 * Configuration (all set on the Worker, never committed):
 *   TURNSTILE_SITE_KEY    var     Turnstile site key (public)
 *   TURNSTILE_SECRET_KEY  secret  Turnstile secret key
 *   MAIL_FROM             secret  sender address on a zone we own (e.g. noreply@lh.tools)
 *   MAIL_TO               secret  private destination inbox
 *   RESEND_API_KEY        secret  optional; only used when the SEND_EMAIL binding is absent
 *   SEND_EMAIL            binding Cloudflare Email Routing "send email" binding
 */

const ALLOWED_ORIGINS = [
  'https://lh.tools',
  'https://www.lh.tools',
  'https://life-hack-tools.github.io',
];

const MAX_BODY_BYTES = 32 * 1024;
const MIN_FILL_SECONDS = 3;

const LIMITS = {
  name: 100,
  email: 254,
  topic: 60,
  app: 60,
  message: 5000,
  page: 300,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
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
    await deliver(env, fields, request);
  } catch (err) {
    console.error('delivery failed', err && err.stack ? err.stack : err);
    return json({ ok: false, error: 'delivery_failed' }, 502, cors);
  }

  return json({ ok: true }, 200, cors);
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

async function deliver(env, fields, request) {
  const from = env.MAIL_FROM;
  const to = env.MAIL_TO;
  if (!from || !to) throw new Error('MAIL_FROM / MAIL_TO are not configured');

  const subject = buildSubject(fields);
  const text = buildBody(fields, request);

  if (env.SEND_EMAIL) {
    const { EmailMessage } = await import('cloudflare:email');
    const raw = buildMime({ from, to, replyTo: fields.email, subject, text });
    await env.SEND_EMAIL.send(new EmailMessage(from, to, raw));
    return;
  }

  if (env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `lh.tools contact <${from}>`,
        to: [to],
        reply_to: fields.email,
        subject,
        text,
      }),
    });
    if (!res.ok) throw new Error(`resend responded ${res.status}: ${await res.text()}`);
    return;
  }

  throw new Error('no delivery channel configured (SEND_EMAIL binding or RESEND_API_KEY)');
}

function buildSubject({ topic, app, lang }) {
  const parts = ['[lh.tools]'];
  if (app) parts.push(app);
  parts.push(topic || 'Contact');
  parts.push(`(${lang})`);
  return parts.join(' ');
}

function buildBody(fields, request) {
  const ray = request.headers.get('CF-Ray') || '-';
  const country = (request.cf && request.cf.country) || '-';
  return [
    `Topic   : ${fields.topic || '-'}`,
    `App     : ${fields.app || '-'}`,
    `Name    : ${fields.name || '-'}`,
    `Email   : ${fields.email}`,
    `Lang    : ${fields.lang}`,
    `Page    : ${fields.page || '-'}`,
    `Country : ${country}`,
    `Ray     : ${ray}`,
    `Received: ${new Date().toISOString()}`,
    '',
    '----------------------------------------------------------------',
    '',
    fields.message,
    '',
  ].join('\n');
}

/* --------------------------------------------------------------------- mime */

function buildMime({ from, to, replyTo, subject, text }) {
  const domain = from.split('@')[1] || 'lh.tools';
  const headers = [
    `From: ${encodeHeader('lh.tools contact')} <${from}>`,
    `To: <${to}>`,
    replyTo ? `Reply-To: <${replyTo}>` : null,
    `Subject: ${encodeHeader(subject)}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    `Date: ${rfc5322Date(new Date())}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean);

  return `${headers.join('\r\n')}\r\n\r\n${wrap(base64(text), 76)}\r\n`;
}

/**
 * RFC 2047 encoded-word. ASCII stays readable; anything else is split into
 * chunks small enough that each encoded word stays under the 75 char limit.
 */
function encodeHeader(value) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value;

  const words = [];
  let chunk = '';
  for (const char of value) {
    const next = chunk + char;
    // 4/3 expansion from base64; keep the encoded word comfortably under 75.
    if (new TextEncoder().encode(next).length > 39) {
      words.push(chunk);
      chunk = char;
    } else {
      chunk = next;
    }
  }
  if (chunk) words.push(chunk);

  return words.map((w) => `=?UTF-8?B?${base64(w)}?=`).join('\r\n ');
}

function rfc5322Date(date) {
  return date.toUTCString().replace(/GMT$/, '+0000');
}

function base64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function wrap(value, width) {
  const lines = [];
  for (let i = 0; i < value.length; i += width) lines.push(value.slice(i, i + width));
  return lines.join('\r\n');
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
 * Strip control characters so they cannot be used to inject mail headers or to
 * forge extra lines in the message we send ourselves. Only the message body is
 * allowed to contain newlines, and they are normalised to \n first.
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

function isEmail(value) {
  return /^[^\s@,;:<>"']+@[^\s@,;:<>"']+\.[^\s@,;:<>"']+$/.test(value) && !/[\r\n]/.test(value);
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
