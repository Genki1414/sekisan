-- 元請名・現場名で積算条件を保存する機能
-- Supabase Studio の SQL Editor でそのまま実行してください

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_name text not null default '',
  site_name text not null default '',
  input jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists projects_user_id_idx on public.projects (user_id, created_at desc);

alter table public.projects enable row level security;

create policy "projects: select own"
  on public.projects for select
  using (auth.uid() = user_id);

create policy "projects: insert own"
  on public.projects for insert
  with check (auth.uid() = user_id);

create policy "projects: update own"
  on public.projects for update
  using (auth.uid() = user_id);

create policy "projects: delete own"
  on public.projects for delete
  using (auth.uid() = user_id);
