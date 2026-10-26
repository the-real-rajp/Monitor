# Developing Monitor

## Prerequisites

- Go 1.24
- Node 22
- PostgreSQL 16 and ClickHouse 24.8 reachable from your machine. The simplest
  way is `docker compose -f deploy/compose/docker-compose.yml up postgres clickhouse`.
- `sqlc` 1.27 (`go install github.com/sqlc-dev/sqlc/cmd/sqlc@v1.27.0`) when
  changing SQL queries.
- `golangci-lint` v2 for `make lint`.

## Running the server

```sh
export MONITOR_POSTGRES_URL='postgres://monitor:monitor@localhost:5432/monitor?sslmode=disable'
export MONITOR_CLICKHOUSE_URL='clickhouse://monitor:monitor@localhost:9000/monitor'
export MONITOR_LOG_FORMAT=text

make dev-server            # migrates on start, listens on :8080
```

Create the first user (this also creates the organisation):

```sh
go run ./cmd/server user create --email you@example.com --name "You" --org "Acme"
```

Then either open http://localhost:8080 (placeholder page when the UI is not
embedded) or run the UI in development mode, which proxies `/api` to the
server:

```sh
make dev-web               # http://localhost:5173
```

## Configuration

All settings are environment variables with a `MONITOR_` prefix.

| Variable | Default | Meaning |
|---|---|---|
| `MONITOR_LISTEN_ADDR` | `:8080` | HTTP listen address |
| `MONITOR_POSTGRES_URL` | required | pgx connection string |
| `MONITOR_CLICKHOUSE_URL` | required | `clickhouse://user:pass@host:9000/db` |
| `MONITOR_PUBLIC_URL` | `http://localhost:8080` | The URL users open; drives cookie security and CSRF checks |
| `MONITOR_SECURE_COOKIES` | true when public URL is https | Force the Secure cookie flag |
| `MONITOR_SESSION_TTL` | `720h` | Login lifetime, sliding |
| `MONITOR_MIGRATE_ON_START` | `true` | Apply migrations before serving |
| `MONITOR_SELF_METRICS_INTERVAL` | `15s` | How often the server writes its own metrics |
| `MONITOR_LOG_LEVEL` | `info` | debug, info, warn, error |
| `MONITOR_LOG_FORMAT` | `json` | json or text |

## Tests

```sh
make test                  # unit tests, no databases needed
make test-integration      # also runs tests tagged `integration`
```

Integration tests read `MONITOR_TEST_PG_URL` and `MONITOR_TEST_CH_URL` and
skip when they are unset. Each test gets a private PostgreSQL schema or
ClickHouse database that is migrated from scratch and dropped afterwards, so
tests can run in parallel against one server.

```sh
export MONITOR_TEST_PG_URL='postgres://monitor:monitor@localhost:5432/monitor_test?sslmode=disable'
export MONITOR_TEST_CH_URL='clickhouse://monitor:monitor@localhost:9000/monitor_test'
```

## Changing the database schema

1. Add `internal/store/pg/migrations/NNNN_name.sql` or
   `internal/store/ch/migrations/NNNN_name.sql`. Migrations are forward-only
   and applied in order. ClickHouse statements are separated by a line
   containing `-- ;;` and must be idempotent.
2. For PostgreSQL, add or edit queries in `internal/store/pg/queries/*.sql`
   and run `make sqlc`. Commit the generated code; CI fails if it is stale.

## Changing the API

`api/openapi.yaml` is the contract. A unit test fails if a route is served
but undocumented, or documented but not served. After editing the spec run
`make openapi-types` to regenerate the TypeScript types the web app uses, and
commit them.

## Repository layout

See section 7 of `docs/PLAN.md`. Decisions with lasting consequences are
recorded in `docs/adr/`.
