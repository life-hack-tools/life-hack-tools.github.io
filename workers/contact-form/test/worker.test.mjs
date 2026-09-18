/**
 * Run with:  node test/worker.test.mjs
 *
 * No dependencies — Node 18+ provides Request/Response/FormData, and both
 * Turnstile verification and the Slack webhook are stubbed through global fetch.
 */
import worker from '../src/index.js';

const ORIGIN = 'https://lh.tools';
// Obviously fake. The real webhook URL is a secret and must never be committed.
const WEBHOOK = 'https://hooks.slack.com/services/T0000TEST/B0000TEST/not-a-real-webhook';

let posts = [];          // every outbound request except Turnstile: { url, raw, body }
let slackStatus = 200;
let slackThrows = null;  // when set, the outbound request throws this
let turnstileOk = true;
let seenSiteverify = null;
let logs = [];

// Hermetic: nothing in this suite may reach the network. Any request other
// than Turnstile is captured and answered here — including requests to hosts
// the Worker should never have called, so the tests can see them.
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
    seenSiteverify = init.body;
    return new Response(JSON.stringify({ success: turnstileOk }), { headers: { 'Content-Type': 'application/json' } });
  }
  if (slackThrows) throw slackThrows;
  let body = null;
  try { body = JSON.parse(init.body); } catch { /* keep raw */ }
  posts.push({ url: u, raw: init.body, body });
  return new Response(slackStatus === 200 ? 'ok' : 'invalid_payload', { status: slackStatus });
};

const realConsoleError = console.error;
console.error = (...args) => {
  logs.push(args.map((a) => (a && a.stack) || String(a)).join(' '));
};
let warns = [];
console.warn = (...args) => { warns.push(args.join(' ')); };

/**
 * Stand-in for a Workers Rate Limiting binding: `limit` successes per key,
 * then failures. Records every key it is asked about.
 */
function makeLimiter(limit = 3) {
  const counts = new Map();
  const calls = [];
  return {
    calls,
    async limit({ key }) {
      calls.push(key);
      const n = (counts.get(key) || 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    },
  };
}

const env = {
  TURNSTILE_SITE_KEY: '0xTESTSITEKEY',
  TURNSTILE_SECRET_KEY: 'secret',
  SLACK_WEBHOOK_URL: WEBHOOK,
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
  posts = []; logs = []; warns = []; slackStatus = 200; slackThrows = null; turnstileOk = true; seenSiteverify = null;
  try { await fn(); realConsoleError(`  ok   ${name}`); pass += 1; }
  catch (err) { realConsoleError(`  FAIL ${name}\n       ${err.message}`); fail += 1; }
}
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const has = (text, needle, m) => { if (!text.includes(needle)) throw new Error(`${m}: missing ${JSON.stringify(needle)}\n---\n${text}\n---`); };
const lacks = (text, needle, m) => { if (text.includes(needle)) throw new Error(`${m}: must not contain ${JSON.stringify(needle)}\n---\n${text}\n---`); };

/** Every Slack control sequence an attacker might try. */
const HOSTILE = '<!channel> <!here> <!everyone> <@U0123ABCD> <#C0123ABCD> <!subteam^S0123> <https://evil.example|クリック> & &lt;';

realConsoleError('/submit (browser)');

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

await check('valid submission is posted once to the configured webhook', async () => {
  const res = await worker.fetch(post(valid), env);
  eq(res.status, 200, 'status');
  eq((await res.json()).ok, true, 'ok');
  eq(posts.length, 1, 'posts');
  eq(posts[0].url, WEBHOOK, 'webhook url');
});

await check('first line names the route, app and topic', async () => {
  await worker.fetch(post(valid), env);
  eq(posts[0].body.text.split('\n')[0], '*[サイト] Batto deletion*', 'title line');
});

await check('reply address sits alone in a code block', async () => {
  await worker.fetch(post(valid), env);
  has(posts[0].body.text, '*返信先*\n```\nvisitor@example.jp\n```', 'reply block');
});

await check('message, name, language and page are included', async () => {
  await worker.fetch(post(valid), env);
  const { text } = posts[0].body;
  has(text, '>共有したスコアの削除をお願いします。', 'quoted message');
  has(text, '*名前*  横島', 'name');
  has(text, '*言語*  ja', 'lang');
  has(text, '*送信元ページ*  `https://lh.tools/privacy/batto/`', 'page in inline code');
});

await check('link and media unfurling are turned off', async () => {
  await worker.fetch(post(valid), env);
  eq(posts[0].body.unfurl_links, false, 'unfurl_links');
  eq(posts[0].body.unfurl_media, false, 'unfurl_media');
});

await check('<!channel> and friends in the message are escaped, not live', async () => {
  await worker.fetch(post({ ...valid, message: `緊急です ${HOSTILE}` }), env);
  const { text } = posts[0].body;
  has(text, '&lt;!channel&gt;', 'escaped channel');
  has(text, '&lt;!here&gt;', 'escaped here');
  has(text, '&lt;@U0123ABCD&gt;', 'escaped user mention');
  has(text, '&lt;https://evil.example|クリック&gt;', 'escaped link');
  has(text, '&amp; &amp;lt;', 'ampersand escaped first, so a typed &lt; stays literal');
  for (const live of ['<!', '<@', '<#', '<http']) lacks(text, live, 'no live control sequence');
});

await check('hostile name, topic, app and page are escaped too', async () => {
  await worker.fetch(post({ ...valid, name: '<!here>', topic: '<!channel>', app: '<@U0123ABCD>', page: '<https://evil.example|x>' }), env);
  const { text } = posts[0].body;
  for (const live of ['<!', '<@', '<http']) lacks(text, live, 'no live control sequence anywhere');
  eq(text.split('\n')[0], '*[サイト] &lt;@U0123ABCD&gt; &lt;!channel&gt;*', 'title escaped');
});

await check('the only raw < > & in the payload are our own formatting', async () => {
  await worker.fetch(post({ ...valid, name: HOSTILE, message: `${HOSTILE}\n${HOSTILE}` }), env);
  const stripped = posts[0].body.text
    .replace(/&(amp|lt|gt);/g, '')    // escaped entities are fine
    .replace(/^>/gm, '');             // our quote marker at line start
  lacks(stripped, '<', 'raw <');
  lacks(stripped, '>', 'raw >');
  lacks(stripped, '&', 'raw &');
});

await check('newlines in single-line fields cannot forge message lines', async () => {
  await worker.fetch(post({ ...valid, name: 'Bad\r\n*返信先*\n```\nattacker@evil.example\n```' }), env);
  const lines = posts[0].body.text.split('\n');
  eq(lines.filter((l) => l === '*返信先*').length, 1, 'exactly one reply label line');
  eq(lines.filter((l) => l === 'attacker@evil.example').length, 0, 'forged address is not on its own line');
  has(posts[0].body.text, '```\nvisitor@example.jp\n```', 'real reply address intact');
});

await check('a forged label inside the message stays inside the quote', async () => {
  await worker.fetch(post({ ...valid, message: '本文です。\n*返信先*\n```\nattacker@evil.example\n```' }), env);
  const lines = posts[0].body.text.split('\n');
  eq(lines.filter((l) => l === '*返信先*').length, 1, 'only our own unquoted label');
  has(posts[0].body.text, '>*返信先*', 'forged label is quoted');
});

await check('message keeps its newlines, one quote marker per line', async () => {
  await worker.fetch(post({ ...valid, message: '一行目\n二行目\n\n四行目です' }), env);
  has(posts[0].body.text, '>一行目\n>二行目\n>\n>四行目です', 'quoted lines');
});

await check('email with a backtick is refused (it could close the code block)', async () => {
  const res = await worker.fetch(post({ ...valid, email: 'a```b@example.jp' }), env);
  eq(res.status, 400, 'status');
  eq((await res.json()).error, 'invalid_email', 'error');
  eq(posts.length, 0, 'nothing posted');
});

await check('turnstile secret and remote ip are forwarded to siteverify', async () => {
  await worker.fetch(post(valid), env);
  eq(seenSiteverify.get('secret'), 'secret', 'secret');
  eq(seenSiteverify.get('response'), 'tok', 'token');
  eq(seenSiteverify.get('remoteip'), '203.0.113.7', 'remoteip');
});

await check('failed turnstile is rejected', async () => {
  turnstileOk = false;
  const res = await worker.fetch(post(valid), env);
  eq(res.status, 403, 'status');
  eq((await res.json()).error, 'challenge_failed', 'error');
  eq(posts.length, 0, 'nothing posted');
});

await check('missing turnstile token is rejected', async () => {
  const res = await worker.fetch(post({ ...valid, turnstileToken: '' }), env);
  eq(res.status, 403, 'status');
  eq(posts.length, 0, 'nothing posted');
});

await check('honeypot submission is silently dropped', async () => {
  const res = await worker.fetch(post({ ...valid, company: 'Acme Marketing' }), env);
  eq(res.status, 200, 'status');
  eq((await res.json()).ok, true, 'looks successful to the bot');
  eq(posts.length, 0, 'nothing posted');
});

await check('instant submission is rejected by the time trap', async () => {
  const res = await worker.fetch(post({ ...valid, elapsed: 1 }), env);
  eq(res.status, 400, 'status');
  eq((await res.json()).error, 'too_fast', 'error');
  eq(posts.length, 0, 'nothing posted');
});

await check('invalid email is rejected', async () => {
  const res = await worker.fetch(post({ ...valid, email: 'not-an-email' }), env);
  eq((await res.json()).error, 'invalid_email', 'error');
});

await check('short message is rejected', async () => {
  const res = await worker.fetch(post({ ...valid, message: 'hi' }), env);
  eq((await res.json()).error, 'message_too_short', 'error');
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

/* ------------------------------------------------------ delivery fails closed */

realConsoleError('\ndelivery (fail closed)');

await check('SLACK_WEBHOOK_URL unset: /submit fails with 502 and says why in the log', async () => {
  const res = await worker.fetch(post(valid), { ...env, SLACK_WEBHOOK_URL: undefined });
  eq(res.status, 502, 'status');
  eq((await res.json()).error, 'delivery_failed', 'error');
  eq(posts.length, 0, 'nothing posted');
  // `wrangler tail` is how the owner will debug a misconfigured deploy.
  has(logs.join('\n'), 'SLACK_WEBHOOK_URL is not configured', 'actionable log line');
});

await check('SLACK_WEBHOOK_URL pointing anywhere but hooks.slack.com fails closed', async () => {
  const res = await worker.fetch(post(valid), { ...env, SLACK_WEBHOOK_URL: 'https://example.com/collect' });
  eq(res.status, 502, 'status');
  eq(posts.length, 0, 'nothing posted');
});

await check('Slack answering non-2xx surfaces as 502, not a silent success', async () => {
  slackStatus = 400;
  const res = await worker.fetch(post(valid), env);
  eq(res.status, 502, 'status');
  eq((await res.json()).error, 'delivery_failed', 'error');
});

await check('webhook URL never appears in logs when Slack rejects the post', async () => {
  slackStatus = 404;
  await worker.fetch(post(valid), env);
  if (!logs.length) throw new Error('expected an error to be logged');
  for (const line of logs) lacks(line, 'B0000TEST', 'log line');
});

await check('webhook URL never appears in logs when the request itself throws', async () => {
  slackThrows = new TypeError(`fetch failed: could not connect to ${WEBHOOK}`);
  const res = await worker.fetch(post(valid), env);
  eq(res.status, 502, 'status');
  if (!logs.length) throw new Error('expected an error to be logged');
  for (const line of logs) lacks(line, 'B0000TEST', 'log line');
});

/* ------------------------------------------------------------- /app-submit */

realConsoleError('\n/app-submit (native apps)');

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

await check('valid app submission is posted', async () => {
  const res = await worker.fetch(appPost(appValid), appEnv);
  eq(res.status, 200, 'status');
  eq((await res.json()).ok, true, 'ok');
  eq(posts.length, 1, 'posts');
  eq(posts[0].body.unfurl_links, false, 'unfurl_links');
  eq(posts[0].body.unfurl_media, false, 'unfurl_media');
});

await check('first line carries route, app, topic, version and platform', async () => {
  await worker.fetch(appPost(appValid), appEnv);
  eq(posts[0].body.text.split('\n')[0], '*[アプリ] Batto bug v1.0.0 (ios)*', 'title line');
});

await check('every meta field is posted', async () => {
  await worker.fetch(appPost(appValid), appEnv);
  const { text } = posts[0].body;
  has(text, '*ビルド・端末*', 'meta label');
  for (const line of [
    'appVersion     : 1.0.0',
    'buildVersion   : 3',
    'runtimeVersion : 1.0.0',
    'platform       : ios',
    'osVersion      : 18.0',
    'locale         : ja-JP',
    'device         : iPhone17,1',
  ]) has(text, line, 'meta line');
  has(text, '>スコア共有を押すと落ちます。', 'quoted message');
  has(text, '*返信先*\n```\nplayer@example.jp\n```', 'reply block');
});

await check('missing meta fields show "-" rather than disappearing', async () => {
  await worker.fetch(appPost({ ...appValid, meta: { platform: 'android' } }), appEnv);
  const { text } = posts[0].body;
  has(text, 'platform       : android', 'platform');
  has(text, 'appVersion     : -', 'missing marked');
  eq(text.split('\n')[0], '*[アプリ] Batto bug (android)*', 'title without version');
});

await check('meta is optional entirely', async () => {
  const res = await worker.fetch(appPost({ app: 'batto', topic: 'feedback', message: 'とても便利に使っています。ありがとう。' }), appEnv);
  eq(res.status, 200, 'status');
  eq(posts[0].body.text.split('\n')[0], '*[アプリ] Batto feedback*', 'title');
});

await check('no email: reply line says なし', async () => {
  const res = await worker.fetch(appPost({ ...appValid, email: '' }), appEnv);
  eq(res.status, 200, 'status');
  has(posts[0].body.text, '*返信先*  なし', 'no reply');
  lacks(posts[0].body.text, '```\n\n```', 'no empty code block');
});

await check('hostile meta and message are escaped', async () => {
  await worker.fetch(appPost({
    ...appValid,
    message: `助けて ${HOSTILE}`,
    meta: { ...appMeta, appVersion: '<!channel>', platform: '<!here>', device: '<@U0123ABCD>', locale: '<https://evil.example|x>' },
  }), appEnv);
  const { text } = posts[0].body;
  for (const live of ['<!', '<@', '<#', '<http']) lacks(text, live, 'no live control sequence');
  eq(text.split('\n')[0], '*[アプリ] Batto bug v&lt;!channel&gt; (&lt;!here&gt;)*', 'title escaped');
  has(text, 'device         : &lt;@U0123ABCD&gt;', 'meta escaped inside code block');
});

await check('newline injection through meta is neutralised', async () => {
  await worker.fetch(appPost({ ...appValid, meta: { ...appMeta, device: 'iPhone\r\n*返信先*\n```\nattacker@evil.example\n```' } }), appEnv);
  const lines = posts[0].body.text.split('\n');
  eq(lines.filter((l) => l === '*返信先*').length, 1, 'exactly one reply label line');
  eq(lines.filter((l) => l === 'attacker@evil.example').length, 0, 'forged address not on its own line');
});

await check('invalid email is rejected when one is supplied', async () => {
  const res = await worker.fetch(appPost({ ...appValid, email: 'nope' }), appEnv);
  eq(res.status, 400, 'status');
  eq((await res.json()).error, 'invalid_email', 'error');
});

await check('missing app key is rejected', async () => {
  const res = await worker.fetch(appPost(appValid, { key: null }), appEnv);
  eq(res.status, 401, 'status');
  eq((await res.json()).error, 'unauthorized', 'error');
  eq(posts.length, 0, 'nothing posted');
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
  const res = await worker.fetch(appPost({ ...appValid, topic: 'wat' }), appEnv);
  eq(res.status, 200, 'status');
  eq(posts[0].body.text.split('\n')[0], '*[アプリ] Batto other v1.0.0 (ios)*', 'title');
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

await check('/app-submit never answers with CORS headers', async () => {
  const res = await worker.fetch(appPost(appValid, { headers: { Origin: 'https://lh.tools' } }), appEnv);
  eq(res.headers.get('Access-Control-Allow-Origin'), null, 'no cors for native route');
});

await check('GET /app-submit is 404', async () => {
  const res = await worker.fetch(new Request('https://form.lh.tools/app-submit'), appEnv);
  eq(res.status, 404, 'status');
});

await check('app route needs no Turnstile token', async () => {
  seenSiteverify = null;
  const res = await worker.fetch(appPost(appValid), appEnv);
  eq(res.status, 200, 'status');
  eq(seenSiteverify, null, 'siteverify never called');
});

await check('SLACK_WEBHOOK_URL unset: /app-submit fails with 502', async () => {
  const res = await worker.fetch(appPost(appValid), { ...appEnv, SLACK_WEBHOOK_URL: undefined });
  eq(res.status, 502, 'status');
  eq((await res.json()).error, 'delivery_failed', 'error');
});

await check('Slack non-2xx on the app route surfaces as 502', async () => {
  slackStatus = 500;
  const res = await worker.fetch(appPost(appValid), appEnv);
  eq(res.status, 502, 'status');
});

/* -------------------------------------------------------------- rate limit */

realConsoleError('\nrate limiting');

const limited = () => ({ ...appEnv, APP_RATE_LIMITER: makeLimiter(), FORM_RATE_LIMITER: makeLimiter() });
const withIp = (ip) => ({ 'CF-Connecting-IP': ip });

function postFrom(ip, body = valid) {
  return new Request('https://form.lh.tools/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  });
}

await check('/submit under the limit behaves exactly as before', async () => {
  const e = limited();
  for (let i = 0; i < 3; i += 1) {
    const res = await worker.fetch(post(valid), e);
    eq(res.status, 200, `request ${i + 1}`);
  }
  eq(posts.length, 3, 'all three delivered');
});

await check('/submit over the limit: 429 rate_limited with Retry-After 60', async () => {
  const e = limited();
  for (let i = 0; i < 3; i += 1) await worker.fetch(post(valid), e);
  const res = await worker.fetch(post(valid), e);
  eq(res.status, 429, 'status');
  eq(res.headers.get('Retry-After'), '60', 'Retry-After');
  eq((await res.json()).error, 'rate_limited', 'error');
});

await check('/submit over the limit calls neither Turnstile nor Slack', async () => {
  const e = limited();
  for (let i = 0; i < 3; i += 1) await worker.fetch(post(valid), e);
  posts = []; seenSiteverify = null;
  await worker.fetch(post(valid), e);
  eq(seenSiteverify, null, 'siteverify not called');
  eq(posts.length, 0, 'nothing posted');
});

await check('/submit 429 carries CORS so the form can read the error', async () => {
  const e = limited();
  for (let i = 0; i < 3; i += 1) await worker.fetch(post(valid), e);
  const res = await worker.fetch(post(valid), e);
  eq(res.status, 429, 'status');
  eq(res.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'cors on 429');
  eq(res.headers.get('Content-Type'), 'application/json; charset=utf-8', 'json body');
});

await check('/submit is keyed form:<ip>', async () => {
  const e = limited();
  await worker.fetch(post(valid), e);
  eq(e.FORM_RATE_LIMITER.calls[0], 'form:203.0.113.7', 'key');
  eq(e.APP_RATE_LIMITER.calls.length, 0, 'app limiter untouched');
});

await check('/submit is limited before the body is even parsed', async () => {
  const e = limited();
  for (let i = 0; i < 3; i += 1) await worker.fetch(post(valid), e);
  const res = await worker.fetch(new Request('https://form.lh.tools/submit', {
    method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.7' }, body: 'garbage',
  }), e);
  eq(res.status, 429, 'rate limit wins over bad_request');
});

await check('each IP gets its own bucket', async () => {
  const e = limited();
  for (let i = 0; i < 3; i += 1) await worker.fetch(postFrom('198.51.100.1'), e);
  eq((await worker.fetch(postFrom('198.51.100.1'), e)).status, 429, 'first ip limited');
  eq((await worker.fetch(postFrom('198.51.100.2'), e)).status, 200, 'second ip unaffected');
});

await check('no CF-Connecting-IP falls into a shared "unknown" bucket', async () => {
  const e = limited();
  const bare = () => new Request('https://form.lh.tools/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify(valid),
  });
  await worker.fetch(bare(), e);
  eq(e.FORM_RATE_LIMITER.calls[0], 'form:unknown', 'form key');
  await worker.fetch(new Request('https://form.lh.tools/app-submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LHT-App-Key': 'batto-key-aaa' }, body: JSON.stringify(appValid),
  }), e);
  eq(e.APP_RATE_LIMITER.calls[0], 'app:batto:unknown', 'app key');
});

await check('GET /config and preflight are not counted', async () => {
  const e = limited();
  await worker.fetch(new Request('https://form.lh.tools/config', { headers: { Origin: ORIGIN } }), e);
  await worker.fetch(new Request('https://form.lh.tools/submit', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), e);
  eq(e.FORM_RATE_LIMITER.calls.length, 0, 'form limiter');
  eq(e.APP_RATE_LIMITER.calls.length, 0, 'app limiter');
});

await check('/app-submit is keyed app:<slug>:<ip>', async () => {
  const e = limited();
  await worker.fetch(appPost(appValid), e);
  eq(e.APP_RATE_LIMITER.calls[0], 'app:batto:203.0.113.9', 'key');
  eq(e.FORM_RATE_LIMITER.calls.length, 0, 'form limiter untouched');
});

await check('/app-submit over the limit: 429, Retry-After, nothing posted, no CORS', async () => {
  const e = limited();
  for (let i = 0; i < 3; i += 1) eq((await worker.fetch(appPost(appValid), e)).status, 200, `request ${i + 1}`);
  posts = [];
  const res = await worker.fetch(appPost(appValid), e);
  eq(res.status, 429, 'status');
  eq(res.headers.get('Retry-After'), '60', 'Retry-After');
  eq((await res.json()).error, 'rate_limited', 'error');
  eq(res.headers.get('Access-Control-Allow-Origin'), null, 'app route stays CORS-free');
  eq(posts.length, 0, 'nothing posted');
});

await check('/app-submit is limited before the app key is checked', async () => {
  const e = limited();
  for (let i = 0; i < 3; i += 1) {
    eq((await worker.fetch(appPost(appValid, { key: 'wrong' }), e)).status, 401, `bad key ${i + 1} still counted`);
  }
  eq((await worker.fetch(appPost(appValid, { key: 'wrong' }), e)).status, 429, 'then limited');
  eq((await worker.fetch(appPost(appValid), e)).status, 429, 'the right key does not reopen the bucket');
});

await check('unknown slugs never reach the limiter (no bucket-per-slug bypass)', async () => {
  const e = limited();
  for (const slug of ['x1', 'x2', 'x3', 'x4']) {
    eq((await worker.fetch(appPost({ ...appValid, app: slug }), e)).status, 400, slug);
  }
  eq(e.APP_RATE_LIMITER.calls.length, 0, 'limiter never consulted with a made-up slug');
});

await check('slug in the key is the normalised one, not the raw input', async () => {
  const e = limited();
  await worker.fetch(appPost({ ...appValid, app: '  BATTO ' }), e);
  eq(e.APP_RATE_LIMITER.calls[0], 'app:batto:203.0.113.9', 'lower-cased and trimmed');
});

await check('different apps from one IP have separate buckets', async () => {
  const e = limited();
  for (let i = 0; i < 3; i += 1) await worker.fetch(appPost(appValid), e);
  eq((await worker.fetch(appPost(appValid), e)).status, 429, 'batto limited');
  const res = await worker.fetch(appPost({ ...appValid, app: 'instantid' }, { key: 'instantid-key-bbb' }), e);
  eq(res.status, 200, 'instantid unaffected');
});

await check('no binding: requests go through and each route warns only once', async () => {
  // A fresh module instance, so the "warn once" state starts clean.
  const fresh = (await import('../src/index.js?rate-limit-warn-once')).default;
  for (let i = 0; i < 5; i += 1) eq((await fresh.fetch(post(valid), appEnv)).status, 200, `submit ${i + 1}`);
  for (let i = 0; i < 5; i += 1) eq((await fresh.fetch(appPost(appValid), appEnv)).status, 200, `app ${i + 1}`);
  eq(posts.length, 10, 'all delivered');
  eq(warns.filter((w) => w.includes('FORM_RATE_LIMITER')).length, 1, 'form warned once');
  eq(warns.filter((w) => w.includes('APP_RATE_LIMITER')).length, 1, 'app warned once');
});

await check('a limiter that throws fails open and is logged', async () => {
  const e = { ...appEnv, FORM_RATE_LIMITER: { async limit() { throw new Error('binding exploded'); } } };
  const res = await worker.fetch(post(valid), e);
  eq(res.status, 200, 'request goes through');
  eq(posts.length, 1, 'delivered');
  has(logs.join('\n'), 'FORM_RATE_LIMITER failed', 'logged');
});

console.error = realConsoleError;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
