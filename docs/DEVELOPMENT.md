# Developing Monitor

Three parts, three toolchains:

| Part | Where | Needs |
|---|---|---|
| Website (PHP API, cron, static host) | `web/` | PHP 8.1+, Composer, MySQL or MariaDB |
| Dashboard (React) | `ui/` | Node 22 |
| Proxy (Go) | `cmd/agent`, `internal/` | Go 1.25 |

## Database

Any local MariaDB or MySQL works. With Docker:

```sh
docker compose -f deploy/compose/docker-compose.yml up mariadb
```

Create `web/config.php` from `web/config.example.php` pointing at it. The
tests use a second database named by `MONITOR_TEST_DSN` (see `web/phpunit.xml`;
defaults to `monitor_test` on localhost with user `monitor`).

## Website

```sh
cd web
composer install
php bin/migrate.php
php bin/user.php create --email you@example.com --name You
make -C .. dev-web                  # http://127.0.0.1:8000
php bin/cron.php                    # run the per-minute job once
vendor/bin/phpunit                  # integration tests against MONITOR_TEST_DSN
```

Routes are registered in `src/App.php`. Each handler is a class in
`src/Handlers/` with methods taking a `Request` and returning a `Response`.
Validation errors are `HttpError`s and become `{"error": {"code", "message"}}`.

Schema changes are new files `web/migrations/NNN_name.sql`, forward-only,
applied by `bin/migrate.php`.

## Dashboard

```sh
cd ui
npm install
npm run dev        # http://localhost:5173, proxies /api to :8000
npm run lint
npm run build      # writes web/public/index.html and web/public/assets/
```

The build output is git-ignored on `main`; the deploy workflow builds it and
commits it to the `deploy` branch.

## Proxy

```sh
go test -race ./...
make agent                                           # bin/monitor-agent
./bin/monitor-agent check -url http://127.0.0.1:8000 -key mon_...
MONITOR_LOG_LEVEL=debug ./bin/monitor-agent -url http://127.0.0.1:8000 -key mon_...
```

Create the key on the Proxies page (or `POST /api/agents`). ICMP needs either
`CAP_NET_RAW` or a `net.ipv4.ping_group_range` that includes your group; as
root both work.

## End to end locally

1. Start MariaDB and the website, create a user, log in at
   http://127.0.0.1:8000.
2. Proxies page: add a proxy, copy the key.
3. Devices page: add `127.0.0.1` pinged by the proxy every 10s.
4. Run the proxy with that key. Within 15 seconds the overview shows the
   device up with a sparkline.
5. Run `php bin/cron.php` a few times (or a `while true; do ...; sleep 60`
   loop) to see rollups and the website pinger.

## Layout

```
cmd/agent/            proxy main
internal/agent/       config, API client, buffer, scheduler, run loop
internal/pinger/      ICMP with unprivileged fallback
web/public/           index.php front controller, .htaccess, built dashboard
web/src/              App, Db, Http/, Auth/, Handlers/, Status/, Ping/, Rollup
web/bin/              cron.php, migrate.php, user.php
web/migrations/       schema
web/resources/        install.sh served at /install.sh
web/tests/            PHPUnit (integration, real database)
ui/                   React dashboard source
deploy/cpanel/        .cpanel.yml for the deploy branch
deploy/agent/         systemd unit, install script
deploy/compose/       local dev stack
.github/workflows/    ci, deploy-branch, release
docs/                 PLAN, DEPLOY, DEVELOPMENT, adr/
```
