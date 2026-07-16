# UNCUORE AI見積 セキュリティ設定

この修正版では、コードをアップロードするだけで次が有効になります。

- 問い合わせ・見積・AI判定のレート制限
- `<script>` / `onerror=` / `javascript:` 等の危険な入力の拒否
- 問い合わせのIP・User-Agent・国・Cloudflare Ray IDをKVへ保存
- 管理画面の保存データをHTMLエスケープしてXSSを防止
- 管理APIで生パスワードを毎回送らず、8時間有効の署名付きセッショントークンを使用
- 管理ログイン失敗をセキュリティイベントとして30日保存
- セキュリティヘッダー追加

## Cloudflare Turnstileを有効にする（推奨）

CloudflareでTurnstileウィジェットを作成し、Pagesプロジェクトの Settings → Variables and secrets に次を追加してください。

- `TURNSTILE_SITE_KEY` : Site key（通常のTextで可）
- `TURNSTILE_SECRET_KEY` : Secret key（Secretで登録）

両方が設定されると、問い合わせフォームに自動でTurnstileが表示され、サーバー側でも検証が必須になります。
設定しない場合でも、その他のセキュリティ対策は有効です。

## 推奨追加設定

- GitHubリポジトリを Private に変更
- `ADMIN_PASSWORD` を16文字以上のランダムな値へ変更
- Cloudflare Pages の Preview deployments を Access で保護
- 不審な送信があった場合は管理画面の問い合わせ一覧に表示されるIP・国・Ray IDを確認

## 既存のテストデータ

過去の `security test` や `<script>alert(1)...` は自動削除しません。管理画面では安全に文字列として表示されます。不要な場合はKVの `inq:` キーから削除してください。
