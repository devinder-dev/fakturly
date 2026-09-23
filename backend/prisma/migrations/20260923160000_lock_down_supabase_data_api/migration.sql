-- Lock the database down against Supabase's auto-generated REST API.
--
-- Supabase publishes every table in `public` through PostgREST (the "Data
-- API") and grants the `anon` and `authenticated` roles full access to new
-- tables. The anon key is public by design. On 2026-09-23 every table here —
-- User (password hashes), RefreshToken, Transaction (the append-only ledger)
-- — had RLS off and SELECT/INSERT granted to anon: anyone with the project's
-- public key could have read or written them without going through our API.
-- Fakturly never uses the Data API; the app connects to Postgres directly.
-- See ADR 54.

-- 1. Row Level Security on every table, with NO policies: deny for any role
--    without BYPASSRLS. The app's own role is unaffected: on Supabase it is
--    `postgres` (BYPASSRLS), elsewhere the table owner, and owners bypass RLS
--    unless FORCE is set. Runs everywhere, so local and CI databases behave
--    the same as production; tests/integration/rls.test.ts keeps new tables
--    from skipping it.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;

-- 2. Take the grants away, now and for tables created later. Only where the
--    Supabase roles exist — a plain Postgres (local Docker, CI) has neither.
--    service_role is left alone: its key is secret and the dashboard uses it.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);

      -- Supabase's default privileges are defined for the `postgres` role,
      -- which is the role migrations run as there.
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
      END IF;
    END IF;
  END LOOP;
END $$;
