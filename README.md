# ChanPro Gather セキュリティ更新

このZIPはフロントHTMLだけでなく、Vercel側の `/api/secure` とSupabase SQLを含みます。HTMLだけ置き換えても、サーバー側の制限は有効になりません。

## 含まれるファイル

- `chanpro-gather.html` — HTMLエディター向けフロントエンド
- `api/secure.js` — IP確認・IPレート制限・登録制限・セッション認証を行うVercel API
- `security.sql` — Supabaseの保護テーブルとRPC関数
- `package.json` / `vercel.json` — Vercel実行設定

## 適用手順

1. Supabase SQL Editorで `security.sql` を**全体実行**します。既存アカウントは `registration_device_accounts` に移行しないため、既存アカウントは今回の「新規作成5アカウント制限」の集計対象外です。
2. Vercelで現在の `api/secure.js` をこのZIPの `api/secure.js` に置き換えます。`package.json` と `vercel.json` もプロジェクトへ反映してデプロイします。
3. Vercelの環境変数を設定します。
   - `SUPABASE_URL` — SupabaseプロジェクトURL
   - `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key（HTMLに絶対に書かない）
   - `SESSION_SECRET` — ランダムな長い秘密値（最低32文字推奨）
   - `IP_HASH_SECRET` — 別のランダムな長い秘密値（最低32文字推奨）
   - `POSTHOG_PROJECT_KEY` — PostHogの**Project API key**（Personal API keyではない）
   - `POSTHOG_API_HOST` — 任意。既定は `https://us.i.posthog.com`
   - `IP_RATE_LIMIT` — 任意。既定120回
   - `IP_RATE_WINDOW_SECONDS` — 任意。既定300秒
   - `IP_BLOCK_SECONDS` — 任意。既定3600秒
4. Vercelを再デプロイします。
5. `chanpro-gather.html` をHTMLエディターに読み込み、ログイン・新規登録・データ表示を確認します。

## 実装内容

- `/api/secure` へのリクエストはサーバーが接続元IPを取得し、IPハッシュを使ってレート制限します。既定は5分間に120回を超えたIPを1時間ブロックします。
- 明示的なIP BANは `banned_ip_addresses` にIPハッシュと期限を保存し、各APIリクエストで確認します。管理者APIの `ip-ban` / `ip-unban` は、ログイン済みの管理者セッションから呼ぶ仕様です。
- IPアドレスはログイン・登録イベントの `$ip` としてPostHogへ送ります。PostHogは分析・記録用で、リアルタイムの遮断判定はサーバーとSupabaseで行います。PostHogの分析APIを毎回問い合わせる構成ではありません。
- PostHogは `person_profiles: "identified_only"` を維持し、ログイン前の匿名イベントからPersonsを作らず、ログイン後の `identify()` でユーザーPersonを識別します。サーバーのセキュリティイベントには `$process_person_profile: false` を付けています。
- 新規登録は、デプロイ後に新しく作成されたアカウントだけを端末ハッシュ単位で数え、5アカウントで上限になります。既存アカウントは遡って数えません。
- Vercel APIは署名付き7日セッションを返し、以降の保護操作は `Authorization: Bearer ...` を検証します。

## 重要な制約

- この端末ハッシュはブラウザーの情報から作るため、ブラウザーの初期化・偽装・別ブラウザー利用で回避される可能性があります。物理端末を完全に一意識別する仕組みではありません。
- IP制限はこのVercel APIに届いた通信に対して有効です。HTML内の既存コードがSupabase RESTへ直接送る投稿・トレンド・ユーザー読み取りは、このVercel APIを通らないため、**IP制限をサイト全体に適用するには、それらの読み取りもサーバー経由へ移す必要があります**。HTMLの初期チェックはブロック表示を出しますが、直接Supabase通信をサーバー側で遮断する代替にはなりません。
- `security.sql` を適用する前に新しいAPIをデプロイすると、必要なRPC/テーブルがないためAPIが503を返します。必ずSQL→Vercel環境変数→デプロイの順に適用してください。
- Supabaseの `users` / `posts` / `hashtags` の読み取り権限・RLSに関する既存の401/406は、別途そのテーブルごとのアクセス方針を修正する必要があります。このZIPはそれらの直接読み取りをすべてVercelへ移行するものではありません。
