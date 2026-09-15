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

/* ------------------------------------------------------------- /app-submit */

console.log('\n/app-submit (native apps)');

const appEnv = {
  ...env,
  APP_KEYS: JSON.stringify({ batto: 'batto-key-aaa', instantid: 'instantid-key-bbb' }),
};

const appMeta = {
  appVersion: '1.0.0',
  buildVersion: '3',
  runtimeVersion: '1.0.0',
  platform: 'ios',
  osVersion: '18.0',
  locale: 'ja-JP',
  device: 'iPhone17,1',
};

const appValid = {
  app: 'batto',
  topic: 'bug',
  message: 'スコア共有を押すと落ちます。3回試して3回とも同じでした。',
  email: 'player@example.jp',
  meta: appMeta,
};

function appPost(body, { key = 'batto-key-aaa', headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', ...headers };
  if (key !== null) h['X-LHT-App-Key'] = key;
  return new Request('https://form.lh.tools/app-submit', { method: 'POST', headers: h, body: JSON.stringify(body) });
}

await check('valid app submission is delivered', async () => {
  sent = [];
  const res = await worker.fetch(appPost(appValid), appEnv);
  eq(res.status, 200, 'status');
  eq((await res.json()).ok, true, 'ok');
  eq(sent.length, 1, 'emails sent');
  eq(sent[0].reply_to, 'player@example.jp', 'reply-to');
});

await check('subject carries app, topic, version and platform', async () => {
  eq(sent[0].subject, '[lh.tools app] Batto bug v1.0.0 (ios)', 'subject');
});

await check('every meta field is rendered into the body', async () => {
  const text = sent[0].text;
  const expected = [
    'App version     : 1.0.0',
    'Build version   : 3',
    'Runtime version : 1.0.0',
    'Platform        : ios',
    'OS version      : 18.0',
    'Locale          : ja-JP',
    'Device          : iPhone17,1',
  ];
  for (const line of expected) {
    if (!text.includes(line)) throw new Error(`body is missing: ${JSON.stringify(line)}\n---\n${text}`);
  }
  if (!text.includes('スコア共有を押すと落ちます')) throw new Error('body lost the message');
  if (!text.includes('Batto (batto)')) throw new Error('body lost the app name');
});

await check('missing meta fields render as "-" rather than disappearing', async () => {
  sent = [];
  await worker.fetch(appPost({ ...appValid, meta: { platform: 'android' } }), appEnv);
  const text = sent[0].text;
  if (!text.includes('Platform        : android')) throw new Error('platform lost');
  if (!text.includes('App version     : -')) throw new Error('missing field not marked');
});

await check('meta is optional entirely', async () => {
  sent = [];
  const res = await worker.fetch(appPost({ app: 'batto', topic: 'feedback', message: 'とても便利に使っています。ありがとう。' }), appEnv);
  eq(res.status, 200, 'status');
  eq(sent.length, 1, 'delivered');
  eq(sent[0].subject, '[lh.tools app] Batto feedback', 'subject without version');
});

await check('email is optional and omits Reply-To when absent', async () => {
  sent = [];
  const res = await worker.fetch(appPost({ ...appValid, email: '' }), appEnv);
  eq(res.status, 200, 'status');
  eq(sent[0].reply_to, undefined, 'reply-to omitted');
  if (!sent[0].text.includes('(not provided')) throw new Error('body should say no reply is possible');
});

await check('invalid email is rejected when one is supplied', async () => {
  const res = await worker.fetch(appPost({ ...appValid, email: 'nope' }), appEnv);
  eq(res.status, 400, 'status');
  eq((await res.json()).error, 'invalid_email', 'error');
});

await check('missing app key is rejected', async () => {
  sent = [];
  const res = await worker.fetch(appPost(appValid, { key: null }), appEnv);
  eq(res.status, 401, 'status');
  eq((await res.json()).error, 'unauthorized', 'error');
  eq(sent.length, 0, 'nothing delivered');
});

await check('wrong app key is rejected', async () => {
  const res = await worker.fetch(appPost(appValid, { key: 'batto-key-aab' }), appEnv);
  eq(res.status, 401, 'status');
});

await check("another app's key cannot be used for this app", async () => {
  const res = await worker.fetch(appPost(appValid, { key: 'instantid-key-bbb' }), appEnv);
  eq(res.status, 401, 'status');
});

await check('fails closed when APP_KEYS is unset', async () => {
  const res = await worker.fetch(appPost(appValid), env);
  eq(res.status, 401, 'status');
});

await check('fails closed when APP_KEYS is malformed', async () => {
  const res = await worker.fetch(appPost(appValid), { ...env, APP_KEYS: 'not json' });
  eq(res.status, 401, 'status');
});

await check('unknown app slug is rejected', async () => {
  const res = await worker.fetch(appPost({ ...appValid, app: 'not-an-app' }), appEnv);
  eq(res.status, 400, 'status');
  eq((await res.json()).error, 'unknown_app', 'error');
});

await check('unknown topic falls back to "other" instead of failing', async () => {
  sent = [];
  const res = await worker.fetch(appPost({ ...appValid, topic: 'wat' }), appEnv);
  eq(res.status, 200, 'status');
  if (!sent[0].text.includes('Topic   : other')) throw new Error('topic not normalised');
});

await check('short message is rejected', async () => {
  const res = await worker.fetch(appPost({ ...appValid, message: 'bad' }), appEnv);
  eq(res.status, 400, 'status');
  eq((await res.json()).error, 'message_too_short', 'error');
});

await check('oversized body is rejected', async () => {
  const res = await worker.fetch(appPost({ ...appValid, message: 'x'.repeat(40000) }), appEnv);
  eq(res.status, 400, 'status');
  eq((await res.json()).error, 'too_large', 'error');
});

await check('header injection through meta is neutralised', async () => {
  sent = [];
  await worker.fetch(appPost({
    ...appValid,
    meta: { ...appMeta, device: 'iPhone\r\nBcc: victim@example.com' },
  }), appEnv);
  eq(sent.length, 1, 'delivered');
  if (sent[0].text.split('\n').some((l) => l.startsWith('Bcc:'))) throw new Error('injected header survived');
  if (/Bcc:/i.test(sent[0].subject)) throw new Error('subject carries injected header');
});

await check('message keeps its newlines while meta does not', async () => {
  sent = [];
  await worker.fetch(appPost({ ...appValid, message: 'line one\nline two\nline three here' }), appEnv);
  if (!sent[0].text.includes('line one\nline two\nline three here')) throw new Error('message newlines lost');
});

await check('/app-submit never answers with CORS headers', async () => {
  const res = await worker.fetch(appPost(appValid, { headers: { Origin: 'https://lh.tools' } }), appEnv);
  eq(res.headers.get('Access-Control-Allow-Origin'), null, 'no cors for native route');
});

await check('GET /app-submit is 404', async () => {
  const res = await worker.fetch(new Request('https://form.lh.tools/app-submit'), appEnv);
  eq(res.status, 404, 'status');
});

await check('app route needs no Turnstile token', async () => {
  sent = [];
  const res = await worker.fetch(appPost(appValid), appEnv);
  eq(res.status, 200, 'status');
  eq(sent.length, 1, 'delivered without any turnstile round trip');
});

await check('delivery failure surfaces as 502', async () => {
  const res = await worker.fetch(appPost(appValid), { ...appEnv, RESEND_API_KEY: undefined });
  eq(res.status, 502, 'status');
  eq((await res.json()).error, 'delivery_failed', 'error');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
