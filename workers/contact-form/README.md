# lh.tools contact form Worker

`https://form.lh.tools` で動く問い合わせ受付 Worker。
**サイトとアプリの問い合わせ窓口を1つに集約**し、内容を**非公開の受信アドレス**へ転送する。
どこにもメールアドレスを公開しないための仕組み。

```
ブラウザ (lh.tools/contact/)          ネイティブアプリ (@life-hack-tools/support)
   │  GET  /config                        │  POST /app-submit
   │  POST /submit                        │  X-LHT-App-Key: <アプリごとのキー>
   │  + Turnstile トークン                │  + meta（バージョン・端末情報）
   ▼                                      ▼
            form.lh.tools (この Worker)
   　　│  検証 → バリデーション → 整形
   　　▼
   Cloudflare Email Routing（送信バインディング）
   　　▼
   非公開の受信アドレス（MAIL_TO シークレット）
```

## エンドポイント

| メソッド | パス | 用途 | 認証 |
|---|---|---|---|
| `GET` | `/config` | `{ "turnstileSiteKey": "0x..." }` を返す。サイトキーをリポジトリに置かずに済ませるため | なし |
| `POST` | `/submit` | サイトのフォーム | Turnstile |
| `POST` | `/app-submit` | アプリ内サポート画面 | `X-LHT-App-Key` |

応答はどちらも `200 {"ok":true}` / エラーは `4xx {"ok":false,"error":"..."}`。

`error` の値: `bad_request` / `too_large` / `too_fast` / `invalid_email` /
`message_too_short` / `challenge_failed` / `unauthorized` / `unknown_app` /
`delivery_failed`

---

## `/app-submit`（ネイティブアプリ用）

Turnstile はブラウザ専用で React Native では動かないため、アプリ用に別経路を用意している。
`/submit` の Turnstile は**ブラウザ用としてそのまま残している**。

### リクエスト

```
POST https://form.lh.tools/app-submit
Content-Type: application/json
X-LHT-App-Key: <アプリごとのキー>

{
  "app": "batto",
  "topic": "feedback" | "bug" | "question" | "deletion",
  "message": "本文",
  "email": "",                    // 任意。返信が要るときだけ
  "meta": {
    "appVersion": "1.0.0",
    "buildVersion": "3",
    "runtimeVersion": "1.0.0",
    "platform": "ios" | "android",
    "osVersion": "18.0",
    "locale": "ja-JP",
    "device": "iPhone17,1"
  }
}
```

| 項目 | 必須 | 挙動 |
|---|---|---|
| `app` | ✔ | 許可リスト外は `unknown_app`。キーは**このアプリ用のもの**である必要がある |
| `topic` | ✔ | 4種以外は `other` に丸める（拒否しない） |
| `message` | ✔ | 10〜5,000 文字。改行は保持される |
| `email` | | 省略可。指定時のみ形式を検証し、`Reply-To` に入る |
| `meta` | | 全項目が任意。欠けた項目はメール本文に `-` と出る |

`meta` は**必ず本文に整形して入る**（サポート対応でバージョンが分からないのが一番困るため）。
実際に届くメール:

```
Subject: [lh.tools app] Batto bug v1.0.0 (ios)
Reply-To: player@example.jp

Topic   : bug
App     : Batto (batto)
Email   : player@example.jp
Country : JP
Ray     : 8f2a1b3c4d5e6f70-NRT
Received: 2026-09-15T11:47:26.990Z

--- Build / device ---------------------------------------------
App version     : 1.0.0
Build version   : 3
Runtime version : 1.0.0
Platform        : ios
OS version      : 18.0
Locale          : ja-JP
Device          : iPhone17,1

----------------------------------------------------------------

スコアを共有しようとすると、共有シートが出る前にアプリが落ちます。
```

`email` を省略した場合は `Reply-To` が付かず、本文に
`Email   : (not provided — no reply possible)` と出る。

### 許可しているアプリ

`batto` / `instantid` / `pitto` / `peckish` / `stockhome` / `mahjong-cho` /
`word-diary` / `mugg` / `rete` / `life-calendar` / `todo-box`

アプリを追加するときは `src/index.js` の `APPS` に slug と表示名を足し、
`APP_KEYS` にそのアプリのキーを足す。

### ⚠ `X-LHT-App-Key` は秘密ではない

アプリのバンドルに入るので、本気で抜く相手には抜かれる。
**ハードルを上げるためだけのもの**として扱うこと。実質的な防御は
下記の**レート制限ルール（必須）**に寄せている。

キーはアプリごとに分けてあるので、1つ漏れても**そのアプリのキーだけ差し替えれば済む**。
Worker 側は「宣言された `app` に対応するキーかどうか」まで検証するため、
Batto のキーで InstantID を名乗ることはできない。

## スパム対策

**`/submit`（ブラウザ）**

1. **Turnstile**（不可視モード）— 送信時に検証
2. **ハニーポット** — 隠しフィールド `company` に入力があれば静かに破棄
3. **時間トラップ** — ページ表示から 3 秒未満の送信を拒否

**`/app-submit`（アプリ）**

1. **アプリごとのキー** — 秘密ではない。ハードル用（上記参照）
2. **レート制限** — Cloudflare 側。**これが実質的な防御なので必ず設定する**

**共通**

- **サイズ・文字数制限** — 本文 5,000 文字 / ボディ全体 32KB / meta 各60文字
- **制御文字の除去** — メールヘッダーインジェクション対策。
  改行を保持するのは本文だけで、それ以外の単一行項目からは落とす

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

### 5. アプリ用のキーを発行（`/app-submit` を使う場合）

アプリごとにランダムなキーを作る。

```bash
# 必要な数だけ生成（アプリごとに別の値にする）
openssl rand -hex 24
```

`APP_KEYS` は **slug → キー の JSON** として1つのシークレットにまとめる。

```bash
cd workers/contact-form
npx wrangler secret put APP_KEYS
# 貼り付ける値（1行でよい）:
# {"batto":"<batto のキー>","instantid":"<instantid のキー>"}
```

生成したキーは、そのアプリ側の `@life-hack-tools/support` の設定に渡す。
アプリを追加するときは、この JSON にエントリを足して `secret put` し直す。

> このキーはアプリのバンドルに入るため**秘密ではない**。漏れた場合は
> そのアプリのエントリだけ新しい値に差し替えて、アプリを再配布すればよい。

### 6. 動作確認

```bash
# サイトキーが返るか
curl https://form.lh.tools/config

# CORS プリフライト
curl -i -X OPTIONS https://form.lh.tools/submit \
  -H 'Origin: https://lh.tools' \
  -H 'Access-Control-Request-Method: POST'

# アプリ経路（届いたメールにバージョン情報が入っているか確認する）
curl -i -X POST https://form.lh.tools/app-submit \
  -H 'Content-Type: application/json' \
  -H 'X-LHT-App-Key: <batto のキー>' \
  -d '{"app":"batto","topic":"bug","message":"デプロイ後の疎通確認です。","meta":{"appVersion":"1.0.0","platform":"ios","osVersion":"18.0"}}'

# キーなしが弾かれるか（401 unauthorized が返ればOK）
curl -i -X POST https://form.lh.tools/app-submit \
  -H 'Content-Type: application/json' \
  -d '{"app":"batto","topic":"bug","message":"これは弾かれるはずです。"}'
```

そのあと https://lh.tools/contact/ から実際に 1 通送信し、
受信ボックスに届くこと・**返信先が送信者のアドレスになっている**ことを確認する。

### 7. レート制限（`/app-submit` を使うなら必須）

Cloudflare ダッシュボード → **Security** → **WAF** → **Rate limiting rules**

アプリ経路のキーは秘密ではないため、**このルールが実質的な防御になる**。

| 項目 | 値 |
|---|---|
| Rule name | `form.lh.tools app-submit` |
| If | `http.host eq "form.lh.tools" and http.request.uri.path eq "/app-submit"` |
| Rate | **5 requests / 10 minutes / IP** |
| Action | Block |

ブラウザ経路にも入れておくとよい（こちらは Turnstile があるので任意）。

| 項目 | 値 |
|---|---|
| Rule name | `form.lh.tools submit` |
| If | `http.host eq "form.lh.tools" and http.request.uri.path eq "/submit"` |
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

38 件。`/submit` 側は CORS・Turnstile 検証・ハニーポット・時間トラップ、
`/app-submit` 側はアプリキーの検証（未設定・不正 JSON でも fail closed になること、
他アプリのキーが使えないこと）・meta の整形・`email` 省略時の挙動・topic の丸め、
両者共通でバリデーション・ヘッダーインジェクション・送信失敗時の 502 を網羅している。

## ローカル開発

```bash
cd workers/contact-form
cp .dev.vars.example .dev.vars   # 値を埋める（.gitignore 済み）
npx wrangler dev
```

`wrangler dev` では Email Routing のバインディングは実送信されないため、
`RESEND_API_KEY` を使うか、`deliver()` の呼び出し箇所をログ出力に差し替えて確認する。
