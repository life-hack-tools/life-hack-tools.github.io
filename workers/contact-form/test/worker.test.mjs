/**
 * Run with:  node test/worker.test.mjs
 *
 * No dependencies — Node 18+ provides Request/Response/FormData, and both
 * Turnstile verification and mail delivery are stubbed through global fetch.
 */
import worker from '../src/index.js';

const ORIGIN = 'https://lh.tools';
let sent = [];          // captured outbound emails (Resend path)
let turnstileOk = true;
let seenSiteverify = null;

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('turnstile/v0/siteverify')) {
    seenSiteverify = init.body;
    return new Response(JSON.stringify({ success: turnstileOk }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (u.includes('api.resend.com')) {
    sent.push(JSON.parse(init.body));
    return new Response('{"id":"x"}', { status: 200 });
  }
  return realFetch(url, init);
};

const env = {
  TURNSTILE_SITE_KEY: '0xTESTSITEKEY',
  TURNSTILE_SECRET_KEY: 'secret',
  MAIL_FROM: 'noreply@lh.tools',
  MAIL_TO: 'private@example.com',
  RESEND_API_KEY: 're_test',
};

function post(body, origin = ORIGIN) {
  return new Request('https://form.lh.tools/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': '203.0.113.7' },
    body: JSON.stringify(body),
  });
}

const valid = {
  topic: 'deletion',
  app: 'Batto',
  name: '横島',
  email: 'visitor@example.jp',
  message: '共有したスコアの削除をお願いします。URL は https://batto.lh.tools/s/abc です。',
  lang: 'ja',
  page: 'https://lh.tools/privacy/batto/',
  elapsed: 42,
  company: '',
  turnstileToken: 'tok',
};

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); pass += 1; }
  catch (err) { console.log(`  FAIL ${name}\n       ${err.message}`); fail += 1; }
}
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

console.log('contact-form worker');

await check('GET /config returns the public site key', async () => {
  const res = await worker.fetch(new Request('https://form.lh.tools/config', { headers: { Origin: ORIGIN } }), env);
  eq(res.status, 200, 'status');
  eq(res.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'cors');
  eq((await res.json()).turnstileSiteKey, '0xTESTSITEKEY', 'site key');
});

await check('OPTIONS preflight is allowed for lh.tools', async () => {
  const res = await worker.fetch(new Request('https://form.lh.tools/submit', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env);
  eq(res.status, 204, 'status');
  eq(res.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'cors');
});

await check('CORS is not granted to an unknown origin', async () => {
  const res = await worker.fetch(new Request('https://form.lh.tools/submit', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env);
  eq(res.headers.get('Access-Control-Allow-Origin'), null, 'cors');
});

await check('valid submission is delivered with the visitor as Reply-To', async () => {
  sent = [];
  const res = await worker.fetch(post(valid), env);
  eq(res.status, 200, 'status');
  eq((await res.json()).ok, true, 'ok');
  eq(sent.length, 1, 'emails sent');
  eq(sent[0].to[0], 'private@example.com', 'recipient');
  eq(sent[0].reply_to, 'visitor@example.jp', 'reply-to');
  eq(sent[0].subject, '[lh.tools] Batto deletion (ja)', 'subject');
  if (!sent[0].text.includes('共有したスコアの削除')) throw new Error('body lost the message');
  if (!sent[0].text.includes('visitor@example.jp')) throw new Error('body lost the sender address');
});

await check('turnstile secret and remote ip are forwarded to siteverify', async () => {
  eq(seenSiteverify.get('secret'), 'secret', 'secret');
  eq(seenSiteverify.get('response'), 'tok', 'token');
  eq(seenSiteverify.get('remoteip'), '203.0.113.7', 'remoteip');
});

await check('failed turnstile is rejected', async () => {
  turnstileOk = false; sent = [];
  const res = await worker.fetch(post(valid), env);
  eq(res.status, 403, 'status');
  eq((await res.json()).error, 'challenge_failed', 'error');
  eq(sent.length, 0, 'emails sent');
  turnstileOk = true;
});

await check('missing turnstile token is rejected', async () => {
  const res = await worker.fetch(post({ ...valid, turnstileToken: '' }), env);
  eq(res.status, 403, 'status');
});

await check('honeypot submission is silently dropped', async () => {
  sent = [];
  const res = await worker.fetch(post({ ...valid, company: 'Acme Marketing' }), env);
  eq(res.status, 200, 'status');
  eq((await res.json()).ok, true, 'looks successful to the bot');
  eq(sent.length, 0, 'nothing delivered');
});

await check('instant submission is rejected by the time trap', async () => {
  const res = await worker.fetch(post({ ...valid, elapsed: 1 }), env);
  eq(res.status, 400, 'status');
  eq((await res.json()).error, 'too_fast', 'error');
});

await check('invalid email is rejected', async () => {
  const res = await worker.fetch(post({ ...valid, email: 'not-an-email' }), env);
  eq((await res.json()).error, 'invalid_email', 'error');
});

await check('short message is rejected', async () => {
  const res = await worker.fetch(post({ ...valid, message: 'hi' }), env);
  eq((await res.json()).error, 'message_too_short', 'error');
});

await check('header injection via name/email is neutralised', async () => {
  sent = [];
  await worker.fetch(post({
    ...valid,
    name: 'Bad\r\nBcc: victim@example.com',
    message: 'Legitimate looking message body here.',
  }), env);
  eq(sent.length, 1, 'delivered');
  if (/Bcc:/i.test(sent[0].subject)) throw new Error('subject carries injected header');
  if (sent[0].text.split('\n').some((l) => l.startsWith('Bcc:'))) throw new Error('injected header survived on its own line');
});

await check('oversized body is rejected', async () => {
  const res = await worker.fetch(post({ ...valid, message: 'x'.repeat(40000) }), env);
  eq(res.status, 400, 'status');
  eq((await res.json()).error, 'too_large', 'error');
});

await check('non-JSON content type is rejected', async () => {
  const res = await worker.fetch(new Request('https://form.lh.tools/submit', {
    method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: ORIGIN }, body: 'hello',
  }), env);
  eq(res.status, 400, 'status');
});

await check('unknown path is 404', async () => {
  const res = await worker.fetch(new Request('https://form.lh.tools/', { headers: { Origin: ORIGIN } }), env);
  eq(res.status, 404, 'status');
});

await check('delivery failure surfaces as 502, not a silent success', async () => {
  const res = await worker.fetch(post(valid), { ...env, RESEND_API_KEY: undefined });
  eq(res.status, 502, 'status');
  eq((await res.json()).error, 'delivery_failed', 'error');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
