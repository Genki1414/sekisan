-- 匿名の利用状況計測（ログイン不要の無料利用者も含む）
-- Supabase Studio の SQL Editor でそのまま実行してください

create table if not exists public.page_views (
  id bigint generated always as identity primary key,
  visitor_id text not null,
  created_at timestamptz not null default now()
);

create index if not exists page_views_created_at_idx on public.page_views (created_at);
create index if not exists page_views_visitor_id_idx on public.page_views (visitor_id);

alter table public.page_views enable row level security;

-- 誰でも記録(insert)はできるが、閲覧(select)はクライアントからは不可
-- (集計はStudioのSQL Editor/Table Editorから確認する想定。ダッシュボード経由の
--  アクセスはRLSの対象外なので、事業者は問題なく閲覧できる)
create policy "page_views: anyone can insert"
  on public.page_views for insert
  with check (true);
