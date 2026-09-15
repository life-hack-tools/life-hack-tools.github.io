# lh.tools contact form Worker

`https://form.lh.tools` で動く問い合わせ受付 Worker。
`https://lh.tools/contact/`（ja / en / vi）から送信された内容を、**非公開の受信アドレス**へ転送する。
サイト上にメールアドレスを一切公開しないための仕組み。

```
ブラウザ (lh.tools/contact/)
   │  GET  /config   → Turnstile サイトキーを取得
   │  POST /submit   → 入力内容 + Turnstile トークン
   ▼
form.lh.tools (この Worker)
   │  Turnstile 検証 → ハニーポット / 時間トラップ → バリデーション
   ▼
Cloudflare Email Routing（送信バインディング）
   ▼
非公開の受信アドレス（MAIL_TO シークレット）
```

## エンドポイント

| メソッド | パス | 内容 |
|---|---|---|
| `GET` | `/config` | `{ "turnstileSiteKey": "0x..." }` を返す。サイトキーをリポジトリに置かずに済ませるため |
| `POST` | `/submit` | `{ ok: true }` / `{ ok: false, error: "..." }` |

`error` の値: `bad_request` / `too_large` / `too_fast` / `invalid_email` /
`message_too_short` / `challenge_failed` / `delivery_failed`

## スパム対策

1. **Turnstile**（不可視モード）— 送信時に検証
2. **ハニーポット** — 隠しフィールド `company` に入力があれば静かに破棄
3. **時間トラップ** — ページ表示から 3 秒未満の送信を拒否
4. **サイズ・文字数制限** — 本文 5,000 文字 / ボディ全体 32KB
5. **制御文字の除去** — メールヘッダーインジェクション対策

---

## デプロイ手順（オーナー作業）

### 1. Turnstile のウィジェットを作成

Cloudflare ダッシュボード → **Turnstile** → **Add widget**

| 項目 | 値 |
|---|---|
| Widget name | `lh.tools contact form` |
| Hostname | `lh.tools` |
| Widget Mode | **Invisible**（または Managed） |

> サイト側は `appearance: 'interaction-only'` で描画するため、
> 通常は Cloudflare のバッジもウィジェットも表示されない。
> Managed を選んだ場合でも、疑わしいアクセス時のみ表示される。

発行される **Site Key**（公開）と **Secret Key**（非公開）を控える。

### 2. Email Routing で受信先アドレスを検証

Cloudflare ダッシュボード → `lh.tools` → **Email** → **Email Routing**

1. Email Routing を有効化（MX / SPF の DNS レコードが自動追加される）
2. **Destination addresses** に、実際に受け取りたい**非公開の個人アドレス**を追加
3. 届いた確認メールのリンクを踏んで **Verified** にする

> この Worker は `MAIL_TO` に指定されたアドレスへ送信する。
> Email Routing の検証済み宛先でないと送信は失敗する。

### 3. Worker をデプロイ

```bash
cd workers/contact-form
npx wrangler deploy
```

`wrangler.toml` の `[[routes]]` により `form.lh.tools` のカスタムドメインと
DNS レコードが自動作成される。

### 4. 変数・シークレットを設定

```bash
cd workers/contact-form

# Turnstile サイトキー（公開値。ブラウザに配るのでシークレットでなくてよい）
npx wrangler secret put TURNSTILE_SITE_KEY

# Turnstile シークレットキー
npx wrangler secret put TURNSTILE_SECRET_KEY

# 送信元（lh.tools 上のアドレス。受信はしない）例: noreply@lh.tools
npx wrangler secret put MAIL_FROM

# 受信先（手順 2 で検証した非公開アドレス）
npx wrangler secret put MAIL_TO
```

> `TURNSTILE_SITE_KEY` はダッシュボードの **Variables** にプレーン変数として
> 設定してもよい。いずれにせよ**リポジトリには置かない**。

### 5. 動作確認

```bash
# サイトキーが返るか
curl https://form.lh.tools/config

# CORS プリフライト
curl -i -X OPTIONS https://form.lh.tools/submit \
  -H 'Origin: https://lh.tools' \
  -H 'Access-Control-Request-Method: POST'
```

そのあと https://lh.tools/contact/ から実際に 1 通送信し、
受信ボックスに届くこと・**返信先が送信者のアドレスになっている**ことを確認する。

### 6. （任意）レート制限

Cloudflare ダッシュボード → **Security** → **WAF** → **Rate limiting rules**

| 項目 | 値 |
|---|---|
| If | `http.host eq "form.lh.tools" and http.request.method eq "POST"` |
| Rate | 10 requests / 1 minute / IP |
| Action | Block |

---

## Email Routing が使えない場合のフォールバック

`SEND_EMAIL` バインディングが無い場合、`RESEND_API_KEY` が設定されていれば
[Resend](https://resend.com) 経由で送信する。

```bash
npx wrangler secret put RESEND_API_KEY
```

この場合 `lh.tools` に Resend の DKIM / SPF レコードを追加し、
`MAIL_FROM` のドメインを Resend 側で検証しておく必要がある。

## テスト

依存パッケージなしで動く。Turnstile 検証とメール送信は `fetch` をスタブして差し替えている。

```bash
cd workers/contact-form
node test/worker.test.mjs
```

CORS・Turnstile 検証・ハニーポット・時間トラップ・バリデーション・
ヘッダーインジェクション・送信失敗時の 502 を網羅している。

## ローカル開発

```bash
cd workers/contact-form
cp .dev.vars.example .dev.vars   # 値を埋める（.gitignore 済み）
npx wrangler dev
```

`wrangler dev` では Email Routing のバインディングは実送信されないため、
`RESEND_API_KEY` を使うか、`deliver()` の呼び出し箇所をログ出力に差し替えて確認する。
