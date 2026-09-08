-- Server-owned billing projection for the private owner analytics dashboard.
--
-- Scout does not currently have a payment provider connected. A future
-- provider webhook should upsert this table with its service-role key. The
-- browser-facing roles intentionally receive no privileges on this table, so
-- a client event can never mark an account as paid.

create table if not exists public.scout_subscriptions (
  provider text not null check (char_length(provider) between 1 and 80),
  provider_subscription_id text not null check (char_length(provider_subscription_id) between 1 and 500),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider_customer_id text,
  status text not null check (status in ('active', 'trialing', 'past_due', 'canceled', 'incomplete', 'unpaid')),
  plan text,
  amount_cents integer check (amount_cents is null or amount_cents >= 0),
  currency text check (currency is null or currency ~ '^[A-Za-z]{3}$'),
  current_period_end timestamptz,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  primary key (provider, provider_subscription_id)
);

create index if not exists scout_subscriptions_user_id_idx
  on public.scout_subscriptions using btree (user_id);

create index if not exists scout_subscriptions_status_idx
  on public.scout_subscriptions using btree (status);

alter table public.scout_subscriptions enable row level security;

revoke all on table public.scout_subscriptions from anon, authenticated;
grant select, insert, update, delete on table public.scout_subscriptions to service_role;
