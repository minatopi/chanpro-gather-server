-- 停止フラグ等の設定
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
insert into public.app_settings (key, value) values
  ('login_enabled', 'true'), ('register_enabled', 'true'),
  ('login_disabled_message', '"現在ログインを停止しています"'),
  ('register_disabled_message', '"現在新規作成を停止しています"')
on conflict (key) do nothing;

-- 報告
create table if not exists public.gather_reports (
  id bigint generated always as identity not null,
  user_id uuid null,
  username text null,
  content text not null,
  status text not null default 'open'::text,
  created_at timestamptz not null default now(),
  constraint gather_reports_pkey primary key (id),
  constraint gather_reports_user_id_fkey foreign key (user_id) references users (id) on delete set null
);
create index if not exists gather_reports_created_at_idx on public.gather_reports using btree (created_at desc);

-- service_role はRLSを無視するので、anonキーからの直接アクセスだけ塞ぐ
alter table public.app_settings enable row level security;
alter table public.gather_reports enable row level security;

-- 既存 users テーブルに不足しているかもしれない列(あれば何もしない)
alter table public.users add column if not exists ban_count integer not null default 0;
alter table public.users add column if not exists last_post_week text;
alter table public.users add column if not exists consecutive_post_weeks integer not null default 0;

-- IP BANテーブル(既にある場合は何もしない)
create table if not exists public.banned_ip_addresses (
  ip_hash text primary key,
  reason text,
  expires_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);
alter table public.banned_ip_addresses enable row level security;

-- Supabase(PostgREST)にテーブル追加を即反映させる
notify pgrst, 'reload schema';

-- ユーザー名BAN / 端末BAN を同じ banned_ip_addresses で管理するための列
-- (端末BANは ip_hash に "device:<端末ハッシュ>" を入れて保存します)
alter table public.banned_ip_addresses add column if not exists kind text not null default 'ip';
alter table public.banned_ip_addresses add column if not exists user_id uuid;
alter table public.banned_ip_addresses add column if not exists username text;
create index if not exists banned_ip_addresses_username_idx on public.banned_ip_addresses (username);
notify pgrst, 'reload schema';
