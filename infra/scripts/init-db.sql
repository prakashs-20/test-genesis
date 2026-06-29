-- Enable extensions required by the platform
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";       -- pgvector for embeddings

-- Create application role for RLS
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'axira_app') THEN
    CREATE ROLE axira_app;
  END IF;
END
$$;

-- Grant connect
GRANT CONNECT ON DATABASE axira_dev TO axira_app;
GRANT USAGE ON SCHEMA public TO axira_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO axira_app;
