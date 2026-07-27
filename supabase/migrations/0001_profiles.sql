-- LINEアカウント紐付け用プロフィールテーブル
-- Supabase Studio の SQL Editor でそのまま実行してください

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  line_user_id text not null unique,
  email text,
  name text,
  picture text,
  -- 見積書PDF差込用の自社情報（PDF機能を使う人だけ設定画面で入力する）
  company_name text,
  company_address text,
  company_phone text,
  company_contact text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles: select own"
  on public.profiles for select
  using (auth.uid() = user_id);

create policy "profiles: update own"
  on public.profiles for update
  using (auth.uid() = user_id);

-- insert / line_user_id・emailの発行は line-login Edge Function が
-- service role で行うため、クライアント向けの insert policy は作らない
