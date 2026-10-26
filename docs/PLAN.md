# Monitor: System Plan

Status: v2, replaces the multi-signal plan of 2026-10-14
Date: 2026-10-24

## 1. What we are building

A ping monitor with a polished web dashboard and a month of history per
device. It answers two questions quickly: is each device reachable right now,
and how has it behaved over the last 30 days.

- Devices inside the office network are pinged by a small proxy running on a
  Linux box or Raspberry Pi on-prem, which pushes results out to the website.
- Devices reachable from the internet, such as the firewall's public address,
  are pinged by the website itself on a one-minute cron.
- Everything is stored in the MySQL database that comes with the Bluehost
  account and served by a PHP application on the same shared hosting plan.

### Constraints that shape the design

| Constraint | Consequence |
|---|---|
| Bluehost shared hosting runs PHP and MySQL, kills processes after 10 minutes, offers no root and no services | The website is PHP with a cPanel cron job. No daemon on the host. All long-running work lives in the on-prem proxy. |
| Shared hosts usually block raw ICMP and may disable `exec` | The website pinger detects at runtime whether `ping` works. When it does not, it falls back to a TCP connect check on a port you choose per device (443 on a firewall, for example), and the UI says which method is in use. |
| The website cannot reach into the office network | The proxy pulls its device list from the website and pushes results out over HTTPS with an API key. No inbound ports, no VPN. |
| cPanel cron granularity is one minute | The minimum ping interval for website-side checks is 60 seconds. The proxy can ping as often as every 10 seconds. |
| One MySQL database, no columnar store | Raw results are kept for 7 days; an hourly rollup table carries the 30-day (and longer) history. Fifty devices every minute is about two million raw rows a month, well within MySQL's comfort zone. |

### Out of scope for v1

HTTP, DNS and TLS checks, server metrics, logs, traces, multi-tenancy, on-call
schedules. The earlier plan's phases 2 to 4 are shelved, not deleted; if the
product grows, that document is in git history.

## 2. Architecture

```
  Office network                                   Bluehost shared hosting
  ┌───────────────────────────┐                    ┌────────────────────────────────┐
  │  Raspberry Pi / Linux box │                    │  PHP application (public_html) │
  │  ┌─────────────────────┐  │  HTTPS, API key    │  ┌──────────┐   ┌───────────┐  │
  │  │ monitor-agent (Go)  │──┼──GET devices ─────▶│  │ JSON API │──▶│  MySQL    │  │
  │  │  pings LAN devices  │──┼──POST results ────▶│  │          │   │           │  │
  │  └─────────────────────┘  │                    │  └──────────┘   └─────┬─────┘  │
  │   switch, printer, NAS,   │                    │  ┌──────────┐         │        │
  │   cameras, servers ...    │                    │  │ cron.php │─────────┘        │
  └───────────────────────────┘                    │  │ 1/minute │ pings external   │
                                                   │  └──────────┘ targets, rolls   │
  Internet-facing devices                          │               up, prunes       │
  ┌───────────────────────────┐   ICMP or TCP      │  ┌──────────────────────────┐  │
  │ firewall WAN, VPS, ISP GW │◀───────────────────┼──│ React dashboard (static) │  │
  └───────────────────────────┘                    │  └──────────────────────────┘  │
                                                   └────────────────────────────────┘
                                                        ▲ browser, HTTPS
```

### Components

1. **Website: PHP application** (`web/`). PHP 8.2, no framework, PDO for
   MySQL, a small router and a handful of handlers. It does four things:
   - Serves the JSON API the dashboard uses (devices, status, history, events).
   - Serves the agent API: device list for an agent, result ingest, heartbeat.
   - Serves the built React dashboard as static files.
   - Runs `bin/cron.php` once a minute from cPanel cron: pings website-side
     devices, updates status, computes hourly rollups, prunes old rows,
     sends alert emails (phase 2). A lock file prevents overlapping runs, and
     the whole run is budgeted to finish in under 40 seconds.

2. **On-prem proxy: `monitor-agent`** (`cmd/agent`, Go). One static binary for
   `linux/arm64`, `linux/arm` (older Pi) and `linux/amd64`, with a systemd unit
   and an install script. It:
   - Reads a config file with the website URL and its API key.
   - Fetches its device list from the website every 60 seconds, so devices are
     managed in the UI, never on the Pi.
   - Pings every device on its interval, in parallel, using ICMP. It runs
     unprivileged via Linux's `ping_group_range` where available and falls back
     to `CAP_NET_RAW`, which the systemd unit grants.
   - Batches results and posts them every 10 seconds. When the website is
     unreachable it buffers in memory, bounded to 24 hours of results, and
     backfills in order when the connection returns, so a Bluehost hiccup does
     not create a false outage in the history.
   - Sends a heartbeat so the UI can show "proxy offline" distinctly from
     "device down".

3. **Dashboard: React** (`ui/`). Vite, TypeScript, TanStack Query, uPlot for
   the charts. Built output is committed to `web/public/assets` by CI so that
   cPanel can deploy from git without a Node toolchain on the host.

## 3. Data model (MySQL, InnoDB, utf8mb4)

| Table | Purpose and key columns |
|---|---|
| `users` | id, email (unique, case-insensitive), name, role (`admin`, `viewer`), password_hash (argon2id via `password_hash`), created_at |
| `sessions` | token_hash (PK), user_id, expires_at, last_seen_at, user_agent |
| `agents` | id, name, key_prefix, key_hash, version, last_seen_at, last_ip, created_at, revoked_at |
| `device_groups` | id, name, sort_order |
| `devices` | id, name, host, group_id, source (`agent` or `web`), agent_id (when source is agent), interval_s, tcp_fallback_port (web source only), enabled, sort_order, notes, created_at |
| `ping_results` | device_id, ts, rtt_ms (NULL on timeout), method (`icmp`, `tcp`). PK (device_id, ts). Raw samples, retained 7 days. |
| `ping_hourly` | device_id, hour (PK with device_id), sent, received, rtt_min, rtt_avg, rtt_max, rtt_p95. Retained 400 days. |
| `device_status` | device_id (PK), state (`up`, `down`, `unknown`), since, consecutive_failures, last_ts, last_rtt_ms, last_method |
| `events` | id, device_id, ts, type (`down`, `up`), duration_s (filled on `up`). The outage log and the source of the uptime bar tooltips. |
| `settings` | `key`, `value`. Down threshold (consecutive failures, default 3), timezone, alert recipients, website pinger method detected. |
| `schema_migrations` | version, applied_at |

Sizing at 50 devices, one-minute interval: raw table about 500k rows at
7 days, hourly table about 480k rows at 400 days. Indexes fit in memory on any
shared plan.

Status logic lives in one PHP function used by both ingest paths: a device
becomes `down` after N consecutive timeouts and `up` on the first success.
Each transition writes an `events` row. The same function will trigger alerts
in phase 2.

## 4. API

Cookie session for the browser, `Authorization: Bearer <key>` for agents.
All responses JSON. Errors use `{"error": {"code", "message"}}`.

| Method and path | Who | Purpose |
|---|---|---|
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` | browser | Sessions |
| `GET /api/overview` | browser | Every device with current status, last RTT, 24h uptime and a 60-point sparkline, in one call |
| `GET /api/devices/{id}/history?range=1h|24h|7d|30d` | browser | Raw points for 1h and 24h, hourly rollups for 7d and 30d |
| `GET /api/devices/{id}/days?days=30` | browser | Per-day uptime percentage and outage count for the 30-day bar strip |
| `GET /api/devices/{id}/events` | browser | Outage log with durations |
| `GET/POST/PATCH/DELETE /api/devices`, `/api/groups` | admin | Device and group management, including reorder |
| `GET/POST/DELETE /api/agents` | admin | Register an agent (key shown once), revoke, see last heartbeat |
| `GET /api/agent/devices` | agent | Its enabled devices with intervals; includes an ETag so unchanged lists cost nothing |
| `POST /api/agent/results` | agent | Batch of `{device_id, ts, rtt_ms}`; idempotent on (device_id, ts) |
| `POST /api/agent/heartbeat` | agent | Version, uptime, queue depth |
| `GET /api/health` | public | Database reachable, last cron run time, website pinger method |

## 5. The dashboard

- **Overview.** Device tiles grouped by `device_groups`. Each tile: name,
  host, a large status dot, current RTT, 24-hour uptime, and a one-hour
  sparkline. Down devices float to the top. A banner appears when an agent has
  not sent a heartbeat for two minutes, because then every device behind it is
  unknown, not down. Polls every 10 seconds.
- **Device page.** The 30-day uptime strip (one bar per day, green to red by
  availability, hover for outages that day). Below it the RTT chart with a
  range switch (1h, 24h, 7d, 30d), min/avg/max bands on rolled-up ranges,
  timeouts drawn as markers. Below that the outage table with start, end and
  duration. Summary numbers for the selected range: uptime, average RTT,
  longest outage.
- **Devices and Agents** pages for admins, with the agent page showing the
  exact install command for a new Pi.
- Light and dark theme from the OS setting, keyboard-accessible, works on a
  phone.

## 6. Deployment

- **Website.** The repository is connected to cPanel's Git Version Control.
  `.cpanel.yml` copies `web/` into the document root of a subdomain such as
  `monitor.example.com`. The cron job is one line in cPanel:
  `* * * * * php /home/<user>/monitor/bin/cron.php`. Configuration (database
  credentials, base URL) lives in a `config.php` outside the document root,
  created once from `config.example.php`.
- **Dashboard build.** GitHub Actions builds `ui/` on every push to `main` and
  commits the output to `web/public/assets` on a `deploy` branch, which is the
  branch cPanel pulls. Developers never commit build output by hand.
- **Agent.** GitHub Actions cross-compiles the three Linux targets on each tag
  and attaches them to a release. The install script downloads the right
  binary, writes `/etc/monitor-agent/config.yaml`, installs the systemd unit
  and starts it.
- **Local development.** `docker compose` with MySQL and PHP's built-in
  server, Vite dev server proxying `/api`. The agent runs with `go run`
  against localhost.

## 7. Repository layout

```
cmd/agent/              monitor-agent main
internal/agent/         config, device list sync, pinger, batcher, uploader
internal/pinger/        ICMP with unprivileged fallback; shared tests
web/
  public/index.php      front controller, serves API and dashboard
  public/assets/        built dashboard (on the deploy branch only)
  src/                  PHP: Router, Db, Auth, Handlers/, Pinger, Status, Rollup, Migrations/
  bin/cron.php          the per-minute job
  bin/migrate.php, bin/user.php
  config.example.php
  composer.json         autoload and PHPUnit only
  tests/
ui/                     React dashboard source
deploy/
  .cpanel.yml           copied to repo root on the deploy branch
  agent/                systemd unit, install.sh
  compose/              local dev stack
docs/
  PLAN.md, DEVELOPMENT.md, adr/
```

## 8. Delivery

Each step leaves something that works end to end. Estimates assume one to
two people.

### Phase 1: pings and the dashboard (3 to 4 weeks)

1. MySQL schema and migrations, PHP skeleton, auth, config, local compose stack.
2. Agent API and the Go agent: device sync, ICMP pinger, batching, buffering,
   heartbeat, systemd unit, install script, cross-compiled builds.
3. Website pinger in cron with ICMP detection and TCP fallback; status engine;
   events; hourly rollup and pruning.
4. Dashboard: overview, device page with the 30-day strip and RTT chart,
   devices, groups, agents, login.
5. cPanel deployment: `.cpanel.yml`, deploy branch workflow, documented cron
   line. First real install on your account.

Exit: your Pi is pinging the office and your firewall is pinged from the
website; the dashboard shows a month of history once a month has passed.

### Phase 2: alerting and polish (1 to 2 weeks)

- Email on down and on recovery, with the threshold and a per-device mute.
  PHP `mail()` on Bluehost, SMTP as an option.
- Maintenance windows that suppress alerts and grey out the strip.
- CSV export of a device's history; a printable monthly report.
- Optional public status page for a chosen subset of devices.

### Phase 3: if wanted later

- TCP and HTTP checks as first-class check types with the same history.
- A second agent at another site, with per-site views.
- Moving the website to a VPS if cron limits or `exec` restrictions bite.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Bluehost disallows `exec` or ICMP, so website pings cannot use `ping` | Built-in TCP fallback, chosen per device; the UI shows the method. Detected on first cron run and shown on the health page. |
| Cron overruns the minute | Website pings run in parallel with a hard 5-second timeout each; the job records its own duration and refuses to start if the previous run holds the lock. |
| Website outage or Bluehost maintenance looks like an office outage | The agent buffers 24 hours and backfills with original timestamps. The status engine processes backfilled results in order. |
| The Pi dies or loses power | Heartbeat-based "proxy offline" state on the overview, distinct from device down. Phase 2 emails about it. |
| MySQL on shared hosting is slow for aggregate queries | The dashboard reads from `device_status`, `ping_hourly` and `events`; the raw table is only touched for 1h and 24h charts of a single device. |
| Secrets in git | `config.php` is outside the document root and git-ignored; agent keys are hashed. |

## 10. Decisions taken

- Shared cPanel hosting, so the website is PHP with cron, not a service.
- The cPanel MySQL database is the only data store.
- The proxy is a Go binary for Linux and Raspberry Pi.
- The multi-signal Phase 0 code (Go server, PostgreSQL, ClickHouse, React
  settings pages) is removed from the tree. Its auth and API conventions carry
  over in spirit. See `docs/adr/003-shared-hosting.md`.

## 11. Progress

- **Phase 1, 2026-10-24: built and verified locally.** PHP API with sessions,
  roles, CSRF and login throttling; MySQL schema with raw results, hourly
  rollups, status engine and outage events; cron job with ICMP detection and
  TCP fallback; the Go proxy with buffering, backfill and heartbeat; the React
  dashboard (overview, device page with 30-day strip and RTT chart, devices,
  proxies, account); install script, systemd unit, cPanel deploy branch
  workflow, release workflow. 15 PHP integration tests and the Go suite pass;
  the proxy was run end to end against the PHP site.
- **Not yet done:** the first install on the Bluehost account (needs the
  database credentials and cPanel steps in `docs/DEPLOY.md`), and a tagged
  release so `install.sh` has binaries to download.
- **Phase 2** (alerts, maintenance windows, exports) has not started.
