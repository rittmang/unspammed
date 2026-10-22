#!/bin/sh
# PostgreSQL runs this only for a new, empty volume. Upgrades preserve roles,
# passwords, schemas and application data.
set -eu
UNSPAMMED_DATABASE_PASSWORD="${UNSPAMMED_DATABASE_PASSWORD:-${WATCHTOWER_DATABASE_PASSWORD:-}}"
export UNSPAMMED_DATABASE_PASSWORD
: "${UNSPAMMED_DATABASE_PASSWORD:?Set UNSPAMMED_DATABASE_PASSWORD for the application role}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv runtime_password UNSPAMMED_DATABASE_PASSWORD
SELECT format('CREATE ROLE watchtower WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'runtime_password') \gexec
GRANT CONNECT, CREATE ON DATABASE watchtower TO watchtower;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
