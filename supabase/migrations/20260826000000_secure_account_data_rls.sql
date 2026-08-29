-- Secure the account-owned data boundary used by Scout.
--
-- The crawler's operational data is currently stored in a server-private
-- SQLite database and is never exposed through the Supabase Data API. These
-- Postgres tables are the canonical RLS contract for data that is exposed to
-- Supabase Auth users (preferences, saved decisions, and the identity
-- projection used to hide duplicate listings).

create table if not exists public.user_internship_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  preferences jsonb not null default '{}'::jsonb
    check (jsonb_typeof(preferences) = 'object'),
  onboarding_step smallint not null default 1
    check (onboarding_step between 1 and 3),
  onboarding_completed boolean not null default false,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  completed_at timestamptz
);

create table if not exists public.user_listing_actions (
  user_id uuid not null references auth.users (id) on delete cascade,
  listing_key text not null check (char_length(listing_key) between 1 and 500),
  listing_type text not null check (listing_type in ('internship', 'grind')),
  listing_id text not null check (char_length(listing_id) between 1 and 500),
  action text not null check (action in ('applied', 'cant_fit')),
  application_status text not null default 'pending'
    check (application_status in ('pending', 'accepted', 'rejected')),
  application_stage text not null default 'applied'
    check (application_stage in ('applied', 'oa', 'recruiter', 'interview', 'final', 'offer', 'rejected')),
  company text not null check (char_length(company) between 1 and 500),
  normalized_company text not null check (char_length(normalized_company) between 1 and 500),
  title text not null check (char_length(title) between 1 and 500),
  application_url text,
  posting_url text,
  job_id text,
  location text,
  created_at timestamptz not null default timezone('utc'::text, now()),
  primary key (user_id, listing_key),
  unique (user_id, listing_type, listing_id)
);

create table if not exists public.user_listing_action_identities (
  user_id uuid not null,
  listing_key text not null,
  identity_key text not null check (char_length(identity_key) between 1 and 1_000),
  direct_job_ids jsonb not null default '[]'::jsonb
    check (jsonb_typeof(direct_job_ids) = 'array'),
  primary key (user_id, listing_key, identity_key),
  foreign key (user_id, listing_key)
    references public.user_listing_actions (user_id, listing_key)
    on delete cascade
);

-- The primary keys begin with user_id, which is the leading RLS predicate for
-- every account-owned table. Keep an explicit index on the action listing
-- identity used by user-scoped reads as well.
create index if not exists user_listing_actions_user_id_idx
  on public.user_listing_actions using btree (user_id);

create index if not exists user_listing_action_identities_user_id_idx
  on public.user_listing_action_identities using btree (user_id);

create index if not exists user_listing_action_identities_identity_key_idx
  on public.user_listing_action_identities using btree (identity_key);

-- RLS and grants are deliberately configured together. Policies narrow rows;
-- grants decide which operations the client roles can attempt at all.
alter table public.user_internship_preferences enable row level security;
alter table public.user_listing_actions enable row level security;
alter table public.user_listing_action_identities enable row level security;

revoke all on table public.user_internship_preferences from anon, authenticated;
revoke all on table public.user_listing_actions from anon, authenticated;
revoke all on table public.user_listing_action_identities from anon, authenticated;

grant select, insert, update, delete on table public.user_internship_preferences to authenticated;
grant select, insert, update, delete on table public.user_listing_actions to authenticated;
grant select, insert, update, delete on table public.user_listing_action_identities to authenticated;

-- Keep administrative access available to the server-side Supabase role. This
-- role bypasses RLS by design and must never be used in browser code.
grant select, insert, update, delete on table public.user_internship_preferences to service_role;
grant select, insert, update, delete on table public.user_listing_actions to service_role;
grant select, insert, update, delete on table public.user_listing_action_identities to service_role;

drop policy if exists "Users can read their own internship preferences" on public.user_internship_preferences;
drop policy if exists "Users can create their own internship preferences" on public.user_internship_preferences;
drop policy if exists "Users can update their own internship preferences" on public.user_internship_preferences;
drop policy if exists "Users can delete their own internship preferences" on public.user_internship_preferences;

create policy "Users can read their own internship preferences"
  on public.user_internship_preferences
  for select
  to authenticated
  using (
    (select auth.uid()) is not null
    and (select auth.uid()) = user_id
  );

create policy "Users can create their own internship preferences"
  on public.user_internship_preferences
  for insert
  to authenticated
  with check (
    (select auth.uid()) is not null
    and (select auth.uid()) = user_id
  );

create policy "Users can update their own internship preferences"
  on public.user_internship_preferences
  for update
  to authenticated
  using (
    (select auth.uid()) is not null
    and (select auth.uid()) = user_id
  )
  with check (
    (select auth.uid()) is not null
    and (select auth.uid()) = user_id
  );

create policy "Users can delete their own internship preferences"
  on public.user_internship_preferences
  for delete
  to authenticated
  using (
    (select auth.uid()) is not null
    and (select auth.uid()) = user_id
  );

drop policy if exists "Users can read their own listing actions" on public.user_listing_actions;
drop policy if exists "Users can create their own listing actions" on public.user_listing_actions;
drop policy if exists "Users can update their own listing actions" on public.user_listing_actions;
drop policy if exists "Users can delete their own listing actions" on public.user_listing_actions;

create policy "Users can read their own listing actions"
  on public.user_listing_actions
  for select
  to authenticated
  using (
    (select auth.uid()) is not null
    and (select auth.uid()) = user_id
  );

create policy "Users can create their own listing actions"
  on public.user_listing_actions
  for insert
  to authenticated
  with check (
    (select auth.uid()) is not null
    and (select auth.uid()) = user_id
  );

create policy "Users can update their own listing actions"
  on public.user_listing_actions
  for update
  to authenticated
  using (
    (select auth.uid()) is not null
    and (select auth.uid()) = user_id
  )
  with check (
    (select auth.uid()) is not null
    and (select auth.uid()) = user_id
  );

create policy "Users can delete their own listing actions"
  on public.user_listing_actions
  for delete
  to authenticated
  using (
    (select auth.uid()) is not null
    and (select auth.uid()) = user_id
  );

drop policy if exists "Users can read their own listing action identities" on public.user_listing_action_identities;
drop policy if exists "Users can create their own listing action identities" on public.user_listing_action_identities;
drop policy if exists "Users can update their own listing action identities" on public.user_listing_action_identities;
drop policy if exists "Users can delete their own listing action identities" on public.user_listing_action_identities;

create policy "Users can read their own listing action identities"
  on public.user_listing_action_identities
  for select
  to authenticated
  using (
    (select auth.uid()) is not null
    and (select auth.uid()) = user_id
  );

create policy "Users can create their own listing action identities"
  on public.user_listing_action_identities
  for insert
  to authenticated
  with check (
    (select auth.uid()) is not null
    and (select auth.uid()) = user_id
  );

create policy "Users can update their own listing action identities"
  on public.user_listing_action_identities
  for update
  to authenticated
  using (
    (select auth.uid()) is not null
    and (select auth.uid()) = user_id
  )
  with check (
    (select auth.uid()) is not null
    and (select auth.uid()) = user_id
  );

create policy "Users can delete their own listing action identities"
  on public.user_listing_action_identities
  for delete
  to authenticated
  using (
    (select auth.uid()) is not null
    and (select auth.uid()) = user_id
  );

-- New public tables/functions should start closed to the client roles. Each
-- future exposed object must grant only the operations its policies support.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
