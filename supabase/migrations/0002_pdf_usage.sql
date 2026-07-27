-- 見積書PDF化のクレジット管理
-- 無料枠：毎月自動で最大3回まで（暦月でリセット）
-- 有料プラン（monthly/annual）中は無制限
-- Supabase Studio の SQL Editor でそのまま実行してください

create table if not exists public.pdf_usage (
  user_id uuid primary key references auth.users(id) on delete cascade,
  free_period_start date not null default date_trunc('month', now())::date,
  free_used_this_period integer not null default 0,
  plan text not null default 'none' check (plan in ('none', 'monthly', 'annual')),
  plan_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.pdf_usage enable row level security;

create policy "pdf_usage: select own"
  on public.pdf_usage for select
  using (auth.uid() = user_id);

-- insert/updateはconsume_pdf_credit()やStripe連携(将来)がservice role/security definerで行うため
-- クライアント向けのinsert/update policyは作らない（残数の改ざん防止）

-- 呼び出したユーザーの無料枠を1消費する（月が変わっていれば自動リセット）。
-- 有料プラン中は残数を減らさずallowed=trueを返す。
create or replace function public.consume_pdf_credit()
returns table (allowed boolean, remaining_free integer, plan text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_row public.pdf_usage;
  v_month_start date := date_trunc('month', now())::date;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;

  insert into public.pdf_usage (user_id)
  values (v_user_id)
  on conflict (user_id) do nothing;

  select * into v_row from public.pdf_usage where user_id = v_user_id for update;

  if v_row.free_period_start <> v_month_start then
    v_row.free_period_start := v_month_start;
    v_row.free_used_this_period := 0;
  end if;

  if v_row.plan in ('monthly', 'annual') and v_row.plan_expires_at is not null and v_row.plan_expires_at > now() then
    update public.pdf_usage
      set free_period_start = v_row.free_period_start,
          free_used_this_period = v_row.free_used_this_period,
          updated_at = now()
      where user_id = v_user_id;
    return query select true, greatest(0, 3 - v_row.free_used_this_period), v_row.plan;
    return;
  end if;

  if v_row.free_used_this_period < 3 then
    v_row.free_used_this_period := v_row.free_used_this_period + 1;
    update public.pdf_usage
      set free_period_start = v_row.free_period_start,
          free_used_this_period = v_row.free_used_this_period,
          updated_at = now()
      where user_id = v_user_id;
    return query select true, greatest(0, 3 - v_row.free_used_this_period), v_row.plan;
    return;
  end if;

  update public.pdf_usage
    set free_period_start = v_row.free_period_start,
        updated_at = now()
    where user_id = v_user_id;
  return query select false, 0, v_row.plan;
end;
$$;

grant execute on function public.consume_pdf_credit() to authenticated;
