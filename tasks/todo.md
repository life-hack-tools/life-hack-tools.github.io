## 2026-10-24 NutriShot Claude移行（#174）
- [x] NutriShot PR #44のコードとAnthropic公式の商用API方針を確認
- [x] ja/en/viの専用privacy・アプリページ・共通privacyの該当箇所を更新
- [x] 9ページのHTML言語/内部リンク/localhost HTTP200と本文一致を確認、専用privacy3言語をChromeで表示確認
- [ ] PR作成
- [ ] ユーザーのマージ承認後に公開ページを照合（本作業で勝手にマージしない）

# NutriShot の専用ポリシー（#168 / PR #169）

- [x] NutriShot main / PR #32、Gemini/Firebase/RevenueCat/Expoの公式資料を照合
- [x] ja/en/viの専用ページを追加（同意、写真の処理、証明情報、購入、更新、削除、推定値）
- [x] 共通ポリシーの「第三者共有なし」と外部送信の矛盾を修正
- [x] 最新mainの他アプリ対応を取り込み、サイトマップで両方を維持
- [x] 3言語のローカルリンク、9節構成、sitemap XMLとURL重複なしを検査
- [x] Chromeで日本語表示・EN/VI切替、390px幅のVI表示を確認。公開は未実施
- [ ] 公開前にCEOレビューと#32の最終運用設定・ストア申告を照合
- [ ] ユーザー確認後にマージ・公開URLのHTTP200と本文を確認

アプリ側で専用ページを参照する変更は、専用URLが公開されてからマージする。アプリのカメラ用途説明修正はNutriShot PR #35。
