# Supabase database security

The migration in `migrations/20260826000000_secure_account_data_rls.sql` is
the repository’s Postgres security contract for account-owned data:

- `public.user_internship_preferences`
- `public.user_listing_actions`
- `public.user_listing_action_identities`

Each table has RLS enabled, no `anon` table grants, explicit
`authenticated` grants, a separate policy for each operation, an ownership
check based on `auth.uid()`, and a leading `user_id` index. The pgTAP files in
`tests/` cover grants plus allowed and denied reads/writes for both anonymous
and authenticated callers.

Run the checks with the Supabase CLI from the project root:

```bash
supabase start
supabase db reset
supabase test db
```

The current Node application uses Supabase Auth for sessions but keeps crawler
and dashboard persistence in a server-private SQLite file. SQLite is not
reachable through Supabase’s Data API, so Postgres RLS cannot protect that
file. The SQL contract should be applied together with any future migration
of account-owned reads/writes to these Postgres tables; until then, do not
describe the SQLite tables as Supabase-RLS protected.
