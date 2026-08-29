begin;

select plan(36);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.user_listing_actions'::regclass),
  'RLS is enabled for listing actions'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.user_listing_action_identities'::regclass),
  'RLS is enabled for listing action identities'
);

select ok(not has_table_privilege('anon', 'public.user_listing_actions', 'select'), 'anon has no action select grant');
select ok(not has_table_privilege('anon', 'public.user_listing_actions', 'insert'), 'anon has no action insert grant');
select ok(not has_table_privilege('anon', 'public.user_listing_actions', 'update'), 'anon has no action update grant');
select ok(not has_table_privilege('anon', 'public.user_listing_actions', 'delete'), 'anon has no action delete grant');
select ok(not has_table_privilege('anon', 'public.user_listing_action_identities', 'select'), 'anon has no identity select grant');
select ok(not has_table_privilege('anon', 'public.user_listing_action_identities', 'insert'), 'anon has no identity insert grant');
select ok(not has_table_privilege('anon', 'public.user_listing_action_identities', 'update'), 'anon has no identity update grant');
select ok(not has_table_privilege('anon', 'public.user_listing_action_identities', 'delete'), 'anon has no identity delete grant');
select ok(has_table_privilege('authenticated', 'public.user_listing_actions', 'select'), 'authenticated has action select grant');
select ok(has_table_privilege('authenticated', 'public.user_listing_actions', 'insert'), 'authenticated has action insert grant');
select ok(has_table_privilege('authenticated', 'public.user_listing_actions', 'update'), 'authenticated has action update grant');
select ok(has_table_privilege('authenticated', 'public.user_listing_actions', 'delete'), 'authenticated has action delete grant');
select ok(has_table_privilege('authenticated', 'public.user_listing_action_identities', 'select'), 'authenticated has identity select grant');
select ok(has_table_privilege('authenticated', 'public.user_listing_action_identities', 'insert'), 'authenticated has identity insert grant');
select ok(has_table_privilege('authenticated', 'public.user_listing_action_identities', 'update'), 'authenticated has identity update grant');
select ok(has_table_privilege('authenticated', 'public.user_listing_action_identities', 'delete'), 'authenticated has identity delete grant');

insert into auth.users (id, email)
values
  ('33333333-3333-3333-3333-333333333333', 'owner-actions@example.com'),
  ('44444444-4444-4444-4444-444444444444', 'other-actions@example.com');

set local role authenticated;
set local request.jwt.claim.sub = '33333333-3333-3333-333333333333';

select results_eq(
  $$insert into public.user_listing_actions (user_id, listing_key, listing_type, listing_id, action, company, normalized_company, title)
    values ('33333333-3333-3333-3333-333333333333', 'internship:owner-1', 'internship', 'owner-1', 'applied', 'Owner Labs', 'owner labs', 'Software Intern')
    returning listing_key$$,
  array['internship:owner-1'],
  'the owner can insert a listing action'
);
select results_eq(
  $$select listing_key from public.user_listing_actions$$,
  array['internship:owner-1'],
  'the owner can read their listing action'
);
select results_eq(
  $$insert into public.user_listing_action_identities (user_id, listing_key, identity_key)
    values ('33333333-3333-3333-3333-333333333333', 'internship:owner-1', 'listing:internship:owner-1')
    returning identity_key$$,
  array['listing:internship:owner-1'],
  'the owner can insert an action identity'
);

set local request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';

select is_empty(
  $$select * from public.user_listing_actions$$,
  'another user reads no listing actions'
);
select throws_ok(
  $$insert into public.user_listing_actions (user_id, listing_key, listing_type, listing_id, action, company, normalized_company, title)
    values ('33333333-3333-3333-3333-333333333333', 'internship:stolen', 'internship', 'stolen', 'cant_fit', 'Owner Labs', 'owner labs', 'Software Intern')$$,
  '42501', null, 'another user cannot insert an owner action'
);
select is_empty(
  $$update public.user_listing_actions set title = 'Stolen'
    where user_id = '33333333-3333-3333-3333-333333333333'
    returning listing_key$$,
  'another user updates no listing actions'
);
select is_empty(
  $$delete from public.user_listing_actions
    where user_id = '33333333-3333-3333-3333-333333333333'
    returning listing_key$$,
  'another user deletes no listing actions'
);
select is_empty(
  $$select * from public.user_listing_action_identities$$,
  'another user reads no action identities'
);
select throws_ok(
  $$insert into public.user_listing_action_identities (user_id, listing_key, identity_key)
    values ('33333333-3333-3333-3333-333333333333', 'internship:owner-1', 'stolen')$$,
  '42501', null, 'another user cannot insert an owner identity'
);
select is_empty(
  $$update public.user_listing_action_identities set identity_key = 'stolen'
    where user_id = '33333333-3333-3333-3333-333333333333'
    returning identity_key$$,
  'another user updates no action identities'
);
select is_empty(
  $$delete from public.user_listing_action_identities
    where user_id = '33333333-3333-3333-3333-333333333333'
    returning identity_key$$,
  'another user deletes no action identities'
);

set local request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';

select throws_ok(
  $$update public.user_listing_actions
    set user_id = '44444444-4444-4444-4444-444444444444'
    where user_id = '33333333-3333-3333-3333-333333333333'
      and listing_key = 'internship:owner-1'$$,
  '42501', null, 'the owner cannot reassign an action to another user'
);
select results_eq(
  $$update public.user_listing_actions
    set application_stage = 'interview'
    where user_id = '33333333-3333-3333-3333-333333333333'
      and listing_key = 'internship:owner-1'
    returning application_stage$$,
  array['interview'],
  'the owner can update their listing action'
);
select results_eq(
  $$select application_stage from public.user_listing_actions
    where user_id = '33333333-3333-3333-3333-333333333333'$$,
  array['interview'],
  'the owner sees the updated action'
);
select results_eq(
  $$update public.user_listing_action_identities
    set direct_job_ids = '["REQ-1"]'::jsonb
    where user_id = '33333333-3333-3333-3333-333333333333'
      and listing_key = 'internship:owner-1'
    returning direct_job_ids->>0$$,
  array['REQ-1'],
  'the owner can update their action identity'
);
select results_eq(
  $$delete from public.user_listing_action_identities
    where user_id = '33333333-3333-3333-3333-333333333333'
      and listing_key = 'internship:owner-1'
    returning identity_key$$,
  array['listing:internship:owner-1'],
  'the owner can delete their action identity'
);
select results_eq(
  $$delete from public.user_listing_actions
    where user_id = '33333333-3333-3333-3333-333333333333'
      and listing_key = 'internship:owner-1'
    returning listing_key$$,
  array['internship:owner-1'],
  'the owner can delete their listing action'
);
select is_empty(
  $$select * from public.user_listing_actions
    where user_id = '33333333-3333-3333-3333-333333333333'$$,
  'deleted listing actions remain deleted'
);

select * from finish();
rollback;
