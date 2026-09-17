# lh.tools contact form Worker

`https://form.lh.tools` で動く問い合わせ受付 Worker。
**サイトとアプリの問い合わせ窓口を1つに集約**し、内容を **Slack の非公開チャンネル**へ投稿する。
どこにもメールアドレスを公開せず、メールの仕組みにも一切触れない。

> [!CAUTION]
> **lh.tools で Cloudflare Email Routing を有効化しないこと。**
>
> lh.tools のメールは **Google Workspace** で動いている
> （MX = `aspmx.l.google.com` ほか、SPF = `v=spf1 include:_spf.google.com ~all` の1本）。
> Email Routing を有効化すると lh.tools 本体に **Cloudflare の MX 3本と2本目の SPF** が追加され、
>
> - 受信メールの一部または全部が Google に届かなくなる
> - SPF が2本になって permerror になり、Google から送るメールの認証も壊れる
>
> サブドメインだけ有効化する方法も、ダッシュボードでは本体の登録が前提になる。
> この Worker がメールではなく Slack に配送しているのはこのため。

```
ブラウザ (lh.tools/contact/)          ネイティブアプリ (@life-hack-tools/support)
   │  GET  /config                        │  POST /app-submit
   │  POST /submit                        │  X-LHT-App-Key: <アプリごとのキー>
   │  + Turnstile トークン                │  + meta（バージョン・端末情報）
   ▼                                      ▼
            form.lh.tools (この Worker)
      │  検証 → バリデーション → エスケープ・整形
      ▼
   Slack Incoming Webhook（SLACK_WEBHOOK_URL シークレット）
      ▼
   非公開チャンネル → オーナーが自分のメールから返信
```

## エンドポイント

| メソッド | パス | 用途 | 認証 |
|---|---|---|---|
| `GET` | `/config` | `{ "turnstileSiteKey": "0x..." }` を返す。サイトキーをリポジトリに置かずに済ませるため | なし |
| `POST` | `/submit` | サイトのフォーム | Turnstile |
| `POST` | `/app-submit` | アプリ内サポート画面 | `X-LHT-App-Key` |

応答はどちらも `200 {"ok":true}` / エラーは `4xx`・`5xx` の `{"ok":false,"error":"..."}`。

`error` の値: `bad_request` / `too_large` / `too_fast` / `invalid_email` /
`message_too_short` / `challenge_failed` / `unauthorized` / `unknown_app` /
`delivery_failed`

**配送は fail closed。** `SLACK_WEBHOOK_URL` が未設定・Slack 以外の URL・Slack が 2xx 以外を返した場合は
`502 delivery_failed` を返す。受け付けたふりはしない（アプリ側はこれを見てブラウザのフォームへ逃がす）。

---

## Slack に届く内容

1行目で**経路・アプリ・種類・版**が分かる。本文は引用で囲い、返信先アドレスは単独のコードブロックに入れる
（mailto に自動リンクされず、そのままコピーできる）。

**アプリ経路**

````
*[アプリ] Batto bug v1.0.0 (ios)*

>スコアを共有しようとすると、共有シートが出る前にアプリが落ちます。
>
>5回試して5回とも同じでした。

*返信先*
```
player@example.jp
```
*ビルド・端末*
```
appVersion     : 1.0.0
buildVersion   : 3
runtimeVersion : 1.0.0
platform       : ios
osVersion      : 18.0
locale         : ja-JP
device         : iPhone17,1
```
受信 2026-09-17T03:25:24.532Z ・ 国 JP ・ Ray 8f2a1b3c4d5e6f70-NRT
````

`email` が無いときは `*返信先*  なし`。`meta` の欠けた項目は `-` と出る
（「送られてこなかった」のか「項目が無い」のか区別できるように）。

**サイト経路**

````
*[サイト] Batto deletion*

>共有したスコアの削除をお願いします。
>https://batto.lh.tools/s/abc

*返信先*
```
visitor@example.jp
```
*名前*  横島
*言語*  ja
*送信元ページ*  `https://lh.tools/privacy/batto/`
受信 2026-09-17T03:25:24.534Z ・ 国 JP ・ Ray 8f2a1b3c4d5e6f70-NRT
````

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
| `email` | | 省略可。指定時のみ形式を検証する |
| `meta` | | 全項目が任意。各60文字まで |

`Content-Type: application/json` 以外は `bad_request` になる。

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

---

## スパム・インジェクション対策

**`/submit`（ブラウザ）**

1. **Turnstile**（不可視モード）— 送信時に検証
2. **ハニーポット** — 隠しフィールド `company` に入力があれば静かに破棄
3. **時間トラップ** — ページ表示から 3 秒未満の送信を拒否

**`/app-submit`（アプリ）**

1. **アプリごとのキー** — 秘密ではない。ハードル用（上記参照）
2. **レート制限** — Cloudflare 側。**これが実質的な防御なので必ず設定する**

**共通**

- **Slack mrkdwn のエスケープ** — 利用者由来の値（本文・名前・メール・topic・app・ページ・meta すべて）は
  Slack の仕様どおり `&` → `&amp;`、`<` → `&lt;`、`>` → `&gt;` に変換してから組み立てる。
  `<!channel>` `<!here>` `<@U123>` `<https://…|リンク>` はただの文字列として表示され、通知もリンクも発生しない。
  投稿に残る生の `<` `>` `&` は、このファイルに書いた書式（引用の `>`）だけ
- **アンファール無効** — `unfurl_links` / `unfurl_media` は false。本文の URL からプレビューを取りに行かない
- **改行インジェクション対策** — 改行を保持するのは本文だけ。名前や meta などの単一行項目からは落とすので、
  偽の `*返信先*` 行を作れない。本文は引用で囲うので、本文内に書かれた偽ラベルは引用の中に見える
- **メールアドレスのバッククォート拒否** — 返信先はコードブロックに入るため、それを閉じられる文字は受け付けない
- **サイズ・文字数制限** — 本文 5,000 文字 / ボディ全体 32KB / meta 各60文字
- **Webhook URL をログに出さない** — 通信エラーの内容はそのまま流さず、エラー種別だけ記録する

---

## デプロイ手順（オーナー作業）

> Webhook URL は**それ自体が認証情報**。リポジトリ・Issue・PR・Slack のメッセージに**書かないこと**。
> このリポジトリは public。

### 1. Slack の Incoming Webhook を発行

1. 投稿先チャンネルを用意する。**利用者のメールアドレスが流れるので非公開チャンネル**にし、メンバーを絞る
2. https://api.slack.com/apps → **Create New App** → **From scratch**
   - App Name: `lh.tools contact`
   - Workspace: LHTz のワークスペース
3. 左メニュー **Incoming Webhooks** → **Activate Incoming Webhooks** を On
4. ページ下部 **Add New Webhook to Workspace** → 1. で用意したチャンネルを選んで **Allow**
5. 発行された `https://hooks.slack.com/services/…` をコピーする（「5. シークレットを設定」で使う。どこにも貼らない）

> 漏れたときは、同じ画面で該当 Webhook を削除して新しく発行し、「5. シークレットを設定」の `SLACK_WEBHOOK_URL` だけやり直す。

### 2. Turnstile のウィジェットを作成

Cloudflare ダッシュボード → **Turnstile** → **Add widget**

| 項目 | 値 |
|---|---|
| Widget name | `lh.tools contact form` |
| Hostname | `lh.tools` |
| Widget Mode | **Invisible**（Managed でも可） |

サイト側は `appearance: 'interaction-only'` で描画するため、通常は Cloudflare のバッジもウィジェットも表示されない。
発行される **Site Key** と **Secret Key** を控える。

### 3. アプリ用のキーを用意

アプリごとにランダムなキーを作り、slug → キー の JSON にまとめる。

```bash
openssl rand -hex 24      # アプリごとに別の値
```

```json
{"batto":"<batto のキー>","instantid":"<instantid のキー>"}
```

生成したキーは、アプリ側の `@life-hack-tools/support` の設定にも渡す。
Batto だけ先に出すなら `{"batto":"..."}` だけで動く。

### 4. Worker をデプロイ

```bash
cd workers/contact-form
npx wrangler deploy
```

`wrangler.toml` の `[[routes]]` により `form.lh.tools` のカスタムドメインと、
**そのサブドメインの DNS レコードだけ**が自動作成される（lh.tools 本体の MX / SPF には触れない）。

この時点ではシークレットが無いので、`/config` は `null` を返しサイトのフォームは X DM への案内を表示し、
送信はすべて失敗する。安全側に倒れているので、そのまま手順5へ。

### 5. シークレットを設定

いずれも**対話プロンプトに貼り付ける**（コマンドの引数や `echo … |` で渡すとシェル履歴に残る）。

```bash
cd workers/contact-form

npx wrangler secret put SLACK_WEBHOOK_URL      # 手順1の Webhook URL
npx wrangler secret put TURNSTILE_SITE_KEY     # 手順2の Site Key（公開値）
npx wrangler secret put TURNSTILE_SECRET_KEY   # 手順2の Secret Key
npx wrangler secret put APP_KEYS               # 手順3の JSON（1行）
```

### 6. 疎通確認

```bash
# サイトキーが返るか
curl https://form.lh.tools/config

# アプリ経路: Slack に「[アプリ] Batto bug v1.0.0 (ios)」が届き、ビルド・端末情報が入っているか
curl -i -X POST https://form.lh.tools/app-submit \
  -H 'Content-Type: application/json' \
  -H 'X-LHT-App-Key: <batto のキー>' \
  -d '{"app":"batto","topic":"bug","message":"デプロイ後の疎通確認です。<!channel> が通知にならないことも確認。","meta":{"appVersion":"1.0.0","platform":"ios","osVersion":"18.0"}}'

# キーなしが弾かれるか（401 unauthorized が返ればOK）
curl -i -X POST https://form.lh.tools/app-submit \
  -H 'Content-Type: application/json' \
  -d '{"app":"batto","topic":"bug","message":"これは弾かれるはずです。"}'
```

1通目で、Slack 上の `<!channel>` が**文字のまま表示され、チャンネル通知が飛ばない**ことを確認する。

そのあと https://lh.tools/contact/ から実際に1通送信し、
「[サイト] …」が届くこと・返信先アドレスをコピーして自分のメールから返信できることを確認する。

> 手順7のあとに何度も試すと、レート制限に引っかかってしばらく弾かれる。疎通確認は手順7の前に済ませる。

### 7. レート制限（必須）

Cloudflare ダッシュボード → `lh.tools` → **Security** → **WAF** → **Rate limiting rules**

アプリ経路のキーは秘密ではないため、**このルールが実質的な防御になる**。
**選べる期間とルール数はプランで変わる**ので、ルール作成画面の **Period** の選択肢を見て、どちらかで作る。

**Period に「10 minutes」がある場合**

| ルール | If | Rate | Action |
|---|---|---|---|
| app-submit | `http.host eq "form.lh.tools" and http.request.uri.path eq "/app-submit"` | 5 requests / 10 minutes / IP | Block |
| submit（任意） | `http.host eq "form.lh.tools" and http.request.uri.path eq "/submit"` | 10 requests / 1 minute / IP | Block |

**Period が「10 seconds」しか無い場合**（Cloudflare のドキュメント上、Free プランはルール1本・期間10秒のみ）

1本で両方の経路を守る。

| 項目 | 値 |
|---|---|
| If | `http.host eq "form.lh.tools" and http.request.method eq "POST" and http.request.uri.path in {"/submit" "/app-submit"}` |
| Rate | 2 requests / 10 seconds / IP |
| Action | Block |

> 10秒窓で2件だと、1つの IP から 10分で最大120件まで通る計算になる（10分5件と比べてかなり緩い）。アプリ経路への実際の流量を見て足りなければ、
> Worker 側でのレート制限（Durable Objects など）を別途検討する。

なお Slack の Incoming Webhook 自体にも投稿頻度の上限（おおむね毎秒1件）があり、超えた分は
Slack が 2xx 以外を返すので `delivery_failed` になる。

---

## テスト

依存パッケージなし・ネットワークなしで動く。Turnstile 検証と Slack への投稿は `fetch` をスタブして捕捉している
（想定外のホストへのリクエストも捕捉されるので、テストが実ネットワークに出ることはない）。

```bash
cd workers/contact-form
node test/worker.test.mjs
```

53 件。

- **Slack**: `<!channel>` `<!here>` `<@U…>` `<#C…>` `<!subteam^…>` `<url|label>` が本文・名前・topic・app・ページ・meta の
  どこから入ってもエスケープされること、`&` を最初に変換していること（`&lt;` と打つと `&amp;lt;` になる）、
  投稿に残る生の `<` `>` `&` が自前の書式だけであること、アンファール無効、1行目の書式、返信先のコードブロック、
  `なし` の表示、meta の整形、単一行項目の改行で偽の行を作れないこと、本文内の偽ラベルが引用に収まること
- **fail closed**: `SLACK_WEBHOOK_URL` 未設定（ログに原因が出ること）・Slack 以外の URL・Slack の非 2xx・通信エラーで 502、
  **いずれの場合もログに Webhook URL が出ないこと**
- **既存**: CORS・Turnstile 検証・ハニーポット・時間トラップ・アプリキー（未設定/不正 JSON で fail closed、
  他アプリのキー不可）・topic の丸め・各種バリデーション

## ローカル開発

```bash
cd workers/contact-form
cp .dev.vars.example .dev.vars   # 値を埋める（.gitignore 済み）
npx wrangler dev
```

`.dev.vars` の `SLACK_WEBHOOK_URL` には**テスト用チャンネルの Webhook** を使うこと。本番チャンネルに流さない。
