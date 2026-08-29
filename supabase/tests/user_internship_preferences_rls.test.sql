begin;

select plan(22);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.user_internship_preferences'::regclass),
  'RLS is enabled for internship preferences'
);

select ok(not has_table_privilege('anon', 'public.user_internship_preferences', 'select'), 'anon has no select grant');
select ok(not has_table_privilege('anon', 'public.user_internship_preferences', 'insert'), 'anon has no insert grant');
select ok(not has_table_privilege('anon', 'public.user_internship_preferences', 'update'), 'anon has no update grant');
select ok(not has_table_privilege('anon', 'public.user_internship_preferences', 'delete'), 'anon has no delete grant');
select ok(has_table_privilege('authenticated', 'public.user_internship_preferences', 'select'), 'authenticated has select grant');
select ok(has_table_privilege('authenticated', 'public.user_internship_preferences', 'insert'), 'authenticated has insert grant');
select ok(has_table_privilege('authenticated', 'public.user_internship_preferences', 'update'), 'authenticated has update grant');
select ok(has_table_privilege('authenticated', 'public.user_internship_preferences', 'delete'), 'authenticated has delete grant');

insert into auth.users (id, email)
values
  ('11111111-1111-1111-1111-111111111111', 'owner-preferences@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'other-preferences@example.com');

set local role anon;

select throws_ok(
  $$select * from public.user_internship_preferences$$,
  '42501', null, 'anon cannot select preferences'
);
select throws_ok(
  $$insert into public.user_internship_preferences (user_id) values ('11111111-1111-1111-1111-111111111111')$$,
  '42501', null, 'anon cannot insert preferences'
);
select throws_ok(
  $$update public.user_internship_preferences set preferences = '{}'::jsonb$$,
  '42501', null, 'anon cannot update preferences'
);
select throws_ok(
  $$delete from public.user_internship_preferences$$,
  '42501', null, 'anon cannot delete preferences'
);

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

select results_eq(
  $$insert into public.user_internship_preferences (user_id, preferences)
    values ('11111111-1111-1111-1111-111111111111', '{"owner":"yes"}'::jsonb)
    returning user_id::text$$,
  array['11111111-1111-1111-1111-111111111111'],
  'the owner can insert preferences'
);
select results_eq(
  $$select preferences->>'owner' from public.user_internship_preferences$$,
  array['yes'],
  'the owner can read their preferences'
);

set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

select is_empty(
  $$select * from public.user_internship_preferences$$,
  'another user reads no preferences'
);
select throws_ok(
  $$insert into public.user_internship_preferences (user_id, preferences)
    values ('11111111-1111-1111-1111-111111111111', '{"stolen":true}'::jsonb)$$,
  '42501', null, 'another user cannot insert for the owner'
);
select is_empty(
  $$update public.user_internship_preferences set preferences = '{"stolen":true}'::jsonb
    where user_id = '11111111-1111-1111-1111-111111111111'
    returning user_id$$,
  'another user updates no preferences'
);
select is_empty(
  $$delete from public.user_internship_preferences
    where user_id = '11111111-1111-1111-1111-111111111111'
    returning user_id$$,
  'another user deletes no preferences'
);

set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

select results_eq(
  $$update public.user_internship_preferences
    set preferences = '{"owner":"updated"}'::jsonb
    where user_id = '11111111-1111-1111-1111-111111111111'
    returning preferences->>'owner'$$,
  array['updated'],
  'the owner can update their preferences'
);
select results_eq(
  $$delete from public.user_internship_preferences
    where user_id = '11111111-1111-1111-1111-111111111111'
    returning user_id::text$$,
  array['11111111-1111-1111-1111-111111111111'],
  'the owner can delete their preferences'
);
select is_empty(
  $$select * from public.user_internship_preferences
    where user_id = '11111111-1111-1111-1111-111111111111'$$,
  'deleted preferences remain deleted'
);

select * from finish();
rollback;
