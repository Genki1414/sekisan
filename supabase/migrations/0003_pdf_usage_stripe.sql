-- Stripe連携用: どのStripe顧客がどのSupabaseユーザーかを引けるようにする
alter table public.pdf_usage add column if not exists stripe_customer_id text;

create unique index if not exists pdf_usage_stripe_customer_id_idx
  on public.pdf_usage (stripe_customer_id)
  where stripe_customer_id is not null;
