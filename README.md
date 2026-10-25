# Chanpro 完全版セットアップ

```
chanpro-complete/
├─ admin-site/   … 管理サイト (Next.js)  → Vercelに【新しいプロジェクト】としてデプロイ
├─ gather-api/   … Gather本体のAPI (api/secure.js + vercel.json) → 既存プロジェクトのファイルを置き換え
└─ sql/setup.sql … Supabaseで実行
```

## 手順 (5ステップ)

1. **SQL**: Supabase の SQL Editor で `sql/setup.sql` を全部実行
   (`app_settings` / `gather_reports` / `banned_ip_addresses` を作成し、`users` に不足列を追加します。既にあるものは何も変わりません)
2. **Gather API を更新**: 既存のAPIプロジェクトの `api/secure.js` を `gather-api/api/secure.js` で上書き。
   `vercel.json` は元のまま(同じ内容)です。環境変数(下表A)を追加して再デプロイ
3. **管理サイトをデプロイ**: `admin-site/` フォルダを Vercel に新規プロジェクトとして追加
   (Framework は Next.js が自動選択されます)。環境変数(下表B)を設定してデプロイ
   - ⚠ 管理サイトには CORS `*` の vercel.json を **置かない** でください(Gather API専用です)
4. **フロントに2行追加** (Gather本体のHTML/JS)
   - APIへ送る body に `page: location.pathname + location.hash` を含める → Axiomの「アクセス」ログにページが出ます
   - ログイン成功後に `posthog.identify(user.id, { username: user.username })` → 管理サイトのPostHogアクセス先に出ます
5. `https://(管理サイトのURL)/login` を開き、`ADMIN_PASSWORD` でログイン

## 環境変数

### A. Gather API (既存プロジェクトに追加するもの)

| 変数 | 必須 | 説明 |
|---|---|---|
| `AXIOM_TOKEN` | 追加 | Axiom の API トークン(Ingest 権限)。未設定ならAxiomへのログ送信だけ無効になります |
| `AXIOM_DATASET` | 追加 | Axiom のデータセット名。省略時 `chanpro`。管理サイトと同じ名前にする |
| `IP_HASH_SECRET` | **管理サイトと同じ値** | IPをハッシュ化する秘密文字列。違うと管理サイトのIP BANが効きません。未設定の場合は `SUPABASE_SERVICE_ROLE_KEY` が使われるので、管理サイト側も同じ状態にするか、両方に明示的に同じ値を入れてください(推奨) |

既存の `SUPABASE_URL` `SUPABASE_SERVICE_ROLE_KEY` `SESSION_SECRET` `POSTHOG_PROJECT_KEY` `POSTHOG_API_HOST` `IP_RATE_LIMIT` `IP_RATE_WINDOW_SECONDS` `IP_BLOCK_SECONDS` はそのままです。

### B. 管理サイト (admin-site)

| 変数 | 必須 | 説明 |
|---|---|---|
| `ADMIN_PASSWORD` | ✅ | 管理サイトのログインパスワード。20文字以上のランダム文字列を推奨 |
| `ADMIN_SESSION_SECRET` | 任意 | ログインCookieの署名鍵。未設定なら `ADMIN_PASSWORD` を使用。別の値にしておくと、署名鍵を変更して全管理セッションを無効化できます |
| `SUPABASE_URL` | ✅ | Gather本体と同じ Supabase URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Gather本体と同じ service_role キー(サーバー専用。絶対に公開しない) |
| `IP_HASH_SECRET` | ✅(推奨) | **Gather APIと同じ値**。IP BAN登録/解除のハッシュ計算に使用 |
| `POSTHOG_PERSONAL_API_KEY` | PostHog閲覧に必要 | PostHog の Personal API key(「Query read」権限)。※ 送信用の `POSTHOG_PROJECT_KEY`(phc_...)とは別物 |
| `POSTHOG_PROJECT_ID` | PostHog閲覧に必要 | PostHog のプロジェクトID(URLの `/project/12345` の数字) |
| `POSTHOG_APP_HOST` | 任意 | 閲覧用ホスト。US: `https://us.posthog.com`(既定) / EU: `https://eu.posthog.com`。取り込み用の `us.i.posthog.com` とは別です |
| `AXIOM_TOKEN` | ✅ | Axiom の API トークン(Query と Ingest 権限)。Gather API と同じものでも可 |
| `AXIOM_DATASET` | 任意 | データセット名。省略時 `chanpro`(Gather APIと同じにする) |

## 管理サイトでできること

- **停止設定**: ログイン停止 / 新規作成停止(メッセージ編集可)。停止中も `admin`・`developer` はログイン可能
- **ユーザー**: 検索、権限(user/admin/developer)変更、公式バッジ(verified)切替、アカウントBAN/解除、PostHogでアクセス先表示
- **IP BAN**: IP入力で期限付きBAN/解除(IPはハッシュ保存なので一覧はハッシュ表示)
- **報告**: `gather_reports` の一覧と open / resolved / dismissed 切替
- **ログ(Axiom)**: ログイン / アクセス / IP制限(期間・ユーザー名で絞り込み)

## Axiomに送られるログの種類 (`type`)

`login_success` `login_failed` `login_blocked` `register_created` `register_blocked` `access` `ip_banned_request` `ip_rate_limited` / 管理操作: `admin_login_success` `admin_login_failed` `admin_user_update` `admin_setting_changed` `admin_ip_ban` `admin_ip_unban`

## 注意

- Axiom には平文IPも保存されます(個人情報)。Axiomの保持期間は短めに設定してください
- `SUPABASE_SERVICE_ROLE_KEY` は全権限キーです。Vercel の環境変数以外に書かないでください
- `guard_ip_request` / `register_account_limited` などの既存SQL関数は、これまで通り適用済みである前提です
