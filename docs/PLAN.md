# Monitor: System Plan

Status: draft for review
Date: 2026-10-14

## 1. What we are building

A self-hosted monitoring platform for a small team that covers three kinds of signal
in one product:

| Area | What it answers | Signal sources |
|---|---|---|
| Uptime | Is the thing reachable from the outside, and how fast? | HTTP, TCP, DNS, TLS, ICMP probes run on a schedule from one or more locations |
| Infrastructure | Are the hosts and containers healthy? | A lightweight agent on each host reporting CPU, memory, disk, network, process and container metrics |
| Applications | What is the code doing? | Metrics, logs and traces emitted by our own services |

Everything funnels into a single alerting engine, a single notification layer and a
single web UI. One place to look, one place to be paged from.

### Scope decisions already made

- Audience: a small team or startup. Dozens to low hundreds of hosts and checks, a
  handful of users. Not multi-tenant SaaS, but the data model keeps an `org_id` so that
  door stays open.
- Build, don't assemble. No Prometheus, Grafana, Alertmanager or Loki. We own the
  collectors, the schema, the query API, the alert evaluator and the dashboard.
- Databases are infrastructure, not "existing monitoring tools". We will not write a
  storage engine. We use PostgreSQL for control-plane data and ClickHouse for telemetry
  (see section 4 for the reasoning and the alternative).
- Open wire protocols where they exist. The ingest path speaks OpenTelemetry (OTLP) so
  applications use standard SDKs instead of one we would have to write and maintain in
  every language. The format is a standard, not a tool.

### Explicitly out of scope for v1

- Multi-tenant billing, per-customer isolation, usage metering.
- Synthetic browser monitoring (scripted Playwright journeys). Possible later.
- A text query language of our own (a PromQL or LogQL clone). v1 uses a structured
  query API. A text language can be layered on later if the UI needs it.
- Mobile apps. The web UI is responsive and that is enough.

## 2. Architecture

```
                     ┌───────────────────────────────────────────────┐
  Internet           │                  monitor-server               │
  ┌──────────┐       │  ┌─────────┐  ┌────────┐  ┌───────────────┐  │
  │ prober   │─OTLP─▶│  │ ingest  │─▶│ writer │─▶│  ClickHouse   │  │
  │ (region) │       │  │ gRPC/   │  └────────┘  │  telemetry    │  │
  └──────────┘       │  │ HTTP    │              └───────┬───────┘  │
                     │  └─────────┘                      │          │
  Hosts              │                        ┌──────────▼───────┐  │
  ┌──────────┐       │                        │  query engine    │  │
  │ agent    │─OTLP─▶│                        └──────────┬───────┘  │
  └──────────┘       │  ┌──────────────┐                 │          │
                     │  │ alert        │◀────────────────┘          │
  Apps               │  │ evaluator    │                            │
  ┌──────────┐       │  └──────┬───────┘   ┌───────────────┐        │
  │ OTel SDK │─OTLP─▶│         ▼           │  PostgreSQL   │        │
  └──────────┘       │  ┌──────────────┐   │  control plane│        │
                     │  │ notifier     │   └───────────────┘        │
                     │  └──────┬───────┘                            │
                     │         │          ┌──────────────┐          │
                     │         │          │ REST + WS API│◀── web UI│
                     └─────────┼──────────┴──────────────┴──────────┘
                               ▼
                 Slack, email, webhook, PagerDuty-style escalation
```

### Components

1. **monitor-server** (Go). One binary, several internal services that can be run
   together for small deployments or split by flag later:
   - *ingest*: OTLP/gRPC and OTLP/HTTP receivers for metrics, logs and traces. Also
     the endpoint probers and agents report to. Validates, enriches with org and
     resource identity, batches, writes.
   - *writer*: batched inserts into ClickHouse with backpressure. Dead-letter on
     schema rejects.
   - *query engine*: translates a structured query (metric, filters, aggregation,
     group-by, window) into ClickHouse SQL. Applies retention tier selection and
     result caps.
   - *scheduler*: decides which prober runs which check and when. Hands out
     assignments; detects dead probers and reassigns.
   - *alert evaluator*: runs every rule on its interval, maintains state
     (inactive, pending, firing, resolved), handles `for` durations, grouping,
     silences and maintenance windows.
   - *notifier*: routes firing alerts to channels by label matchers, deduplicates,
     retries with backoff, records delivery outcomes, drives escalation timers.
   - *API*: REST for CRUD and queries, WebSocket for live tails and alert feed.
     Serves the built web UI as static files so one container is a full install.

2. **monitor-prober** (Go). Stateless worker. Pulls assignments from the server,
   runs HTTP, TCP, DNS, TLS-expiry and ICMP checks with per-check timeouts, records
   phase timings (DNS, connect, TLS, first byte, total), ships results as OTLP
   metrics plus a structured log record per failure. Run one per region; results
   carry a `region` label so the UI can show "down from 2 of 3 locations".

3. **monitor-agent** (Go). Runs on every host. Reads `/proc`, `/sys`, cgroups and
   the Docker socket when present. Reports host and container metrics every 15s by
   default, tails configured log files and ships them as OTLP logs. Single static
   binary, systemd unit, under 50 MB resident.

4. **monitor-web** (TypeScript, React, Vite). The dashboard: overview, check
   detail, host detail, service detail, log search, trace waterfall, dashboard
   builder, alert rules, incidents, status page settings, user admin. Also renders
   the public status page.

5. **Storage**: PostgreSQL 16 for users, orgs, checks, agents, rules, silences,
   notification channels, incidents, dashboards and alert state. ClickHouse for
   check results, metrics, logs and spans.

## 3. Data model

### Control plane (PostgreSQL)

| Table | Purpose |
|---|---|
| `orgs`, `users`, `memberships` | Identity. Roles: admin, member, viewer. |
| `api_keys` | Ingest and automation keys, hashed, scoped to org and signal type. |
| `checks` | Uptime checks: type, target, interval, timeout, assertions, regions, labels. |
| `probers`, `agents` | Registered collectors, last heartbeat, version, assigned work. |
| `alert_rules` | Query, condition, `for` duration, severity, labels, annotations. |
| `alert_states` | Current state per rule per label set. Rebuilt from ClickHouse on restart if lost. |
| `silences`, `maintenance_windows` | Matchers plus time range. |
| `notification_channels`, `routes`, `escalation_policies`, `on_call_schedules` | Who gets told, how, and what happens if they do not ack. |
| `incidents`, `incident_events` | Grouped firing alerts with a timeline, acks and notes. |
| `dashboards` | JSON layout of panels, each panel holding a structured query. |
| `status_pages`, `status_components` | Public page configuration and component-to-check mapping. |

### Telemetry (ClickHouse)

All telemetry tables are partitioned by day and ordered to make the common query
(one org, one resource, one name, a time range) a tight range scan.

- `metrics_raw(org_id, metric, labels Map(String,String), ts DateTime64(3), value Float64, resource_id)`
  Ordered by `(org_id, metric, resource_id, ts)`. TTL per org, default 15 days.
- `metrics_5m`, `metrics_1h` materialized views with min, max, avg, sum, count and
  last. TTL 90 days and 2 years. The query engine picks the tier from the requested
  window and step.
- `check_results(org_id, check_id, region, ts, ok UInt8, status_code, phase_dns_ms,
  phase_connect_ms, phase_tls_ms, phase_ttfb_ms, total_ms, error String)`. TTL 90 days
  raw, rolled up to daily availability forever for SLA reports.
- `logs(org_id, ts, resource_id, service, severity, body String, attrs Map, trace_id,
  span_id)` with a tokenized bloom-filter skip index on `body` and an index on
  `trace_id`. TTL 14 days default.
- `spans(org_id, trace_id, span_id, parent_span_id, service, name, start_ts,
  duration_ns, status, attrs Map)`. Ordered by `(org_id, service, start_ts)` with a
  secondary projection by `trace_id`. TTL 7 days default. Tail sampling of error and
  slow traces is a phase 3 addition.

Cardinality control: the ingest path enforces per-org limits on distinct label sets
per metric and rejects or truncates above the cap, with a visible counter in the UI.
This is the single most common way monitoring systems fall over and it is cheaper to
build in on day one.

## 4. Technology choices

| Layer | Choice | Why | Alternative considered |
|---|---|---|---|
| Server, prober, agent | Go 1.23 | Single static binaries, cheap goroutines for thousands of concurrent probes, mature OTLP and ClickHouse libraries, trivial cross-compilation for the agent. | Rust (slower to iterate for a small team), Python (agent footprint and probe concurrency are weaker). |
| Web UI | TypeScript, React 18, Vite, TanStack Query, a charting library built on uPlot for dense time series | Largest hiring pool and ecosystem; uPlot renders 100k points without choking. | SvelteKit (smaller, fine choice if the team prefers it). |
| Control plane DB | PostgreSQL 16 | Boring, transactional, excellent for configuration and state. | SQLite for single-node (rejected because the prober and server need to share state across hosts). |
| Telemetry DB | ClickHouse | One columnar store handles metrics, logs and traces at this scale on one node; compression is 10 to 20x; built-in TTL, materialized rollups and skip indexes do the work a custom TSDB would otherwise need. | TimescaleDB only: simpler ops (one database) and fine for metrics and check results, but weak for log search and span storage. If the team strongly prefers one database, take this and accept that logs and traces get a different store later. |
| Ingest protocol | OTLP (gRPC and HTTP/protobuf) | Standard SDKs in every language; our prober and agent speak it too so there is one ingest path. | Custom protobuf (saves nothing, costs SDKs). Prometheus scrape compatibility is a phase 2 add-on, not a replacement. |
| Auth | Email and password with argon2id, sessions in Postgres, API keys for machines. OIDC login in phase 4. | Enough for a small team. | |
| Packaging | Docker images per binary, one `docker compose` file for a full install, Helm chart in phase 4. | | |
| CI | GitHub Actions: lint, unit tests, integration tests against real Postgres and ClickHouse containers, build images. | | |

## 5. Key behaviours in detail

### Uptime checks

- Types: HTTP(S) with method, headers, body, expected status range, body substring or
  JSON path assertion, max response time; TCP connect; DNS record match; TLS
  certificate expiry threshold; ICMP ping (needs `CAP_NET_RAW` on the prober).
- Intervals from 10s to 1h. Each check runs from every region assigned to it.
- A check is `down` only when a configurable quorum of regions agree (default: more
  than half), which filters single-location network blips.
- Each result stores phase timings, so the detail page can show where latency went.
- Confirmation retry: on first failure, retry once after 5s from the same region
  before reporting, to cut flapping.

### Metrics query API

A structured query object, not a language:

```json
{
  "metric": "system.cpu.utilization",
  "filters": {"host": "web-*", "state": "user"},
  "aggregate": "avg",
  "group_by": ["host"],
  "window": {"from": "now-6h", "to": "now", "step": "1m"},
  "functions": [{"rate": "1m"}]
}
```

The same object is used by dashboard panels, alert rules and the explore page, so
there is exactly one translator to ClickHouse SQL to test and optimise.

### Alert evaluation

- Rule kinds: threshold on a metric query, uptime (check down in N regions for M
  minutes), log pattern count, trace error rate or p99 latency, and heartbeat
  (expected metric or log stopped arriving).
- State machine per rule and label set: inactive, pending (condition true, `for`
  not yet met), firing, resolved. Transitions are written to Postgres and emitted
  as an event.
- Grouping: alerts sharing a configurable label set (default: rule and service) are
  grouped into one incident so a single outage produces one page, not fifty.
- Silences and maintenance windows suppress notification but not evaluation, so the
  UI still shows true state.
- Flap protection: a resolved alert that re-fires within a cooldown re-opens the same
  incident rather than creating a new one.

### Notification and escalation

- Channels: email (SMTP), Slack (incoming webhook and app), generic webhook with
  signed payload, Microsoft Teams, Discord, SMS and voice via Twilio (phase 4).
- Routes match alerts by label to channels, with per-route repeat interval.
- Escalation policy: step 1 notifies the on-call person, if not acknowledged in N
  minutes step 2 notifies the next, then a whole channel. Acks come from the UI or by
  replying to the notification where the channel supports it.
- Every delivery attempt is recorded so "did anyone get paged" is answerable.

### Public status page

- Per org, optional custom domain, components mapped to checks or rules, 90-day
  uptime bars, incident posts with updates, subscriber emails. Served by the same
  binary with aggressive caching since it is the one page that must stay up when
  everything else is down.

## 6. Capacity targets for v1

Sizing for a single server with 8 vCPU, 32 GB RAM and NVMe, which should cover a
small team comfortably:

| Dimension | Target |
|---|---|
| Hosts with agent | 300 |
| Metric series | 500,000 active |
| Metric samples | 40,000 per second sustained |
| Uptime checks | 1,000 at 30s from 3 regions |
| Logs | 5,000 lines per second, 14-day retention |
| Spans | 2,000 per second after sampling, 7-day retention |
| Query latency | p95 under 1s for a 6-hour dashboard panel, under 5s for a 30-day log search |
| Alert evaluation | 1,000 rules every 15s with under 2s lag |
| Ingest to visible | under 10s |

These are design targets, not promises. Phase 2 includes a load-generation tool to
measure them and the numbers get revised from evidence.

## 7. Repository layout

A single Go module and a single npm workspace in one repository:

```
cmd/
  server/           main for monitor-server
  prober/           main for monitor-prober
  agent/            main for monitor-agent
internal/
  api/              HTTP handlers, OpenAPI spec, auth middleware
  ingest/           OTLP receivers, validation, cardinality limits
  store/
    pg/             sqlc-generated queries, migrations
    ch/             ClickHouse schema, writers, query translator
  query/            structured query model and planner
  alerting/         evaluator, state machine, grouping
  notify/           channel implementations, routing, escalation
  scheduler/        check assignment to probers
  probes/           http, tcp, dns, tls, icmp implementations
  hostmetrics/      /proc, cgroup and docker collectors used by the agent
  model/            shared domain types
web/                React app, built output embedded into the server binary
deploy/
  compose/          docker-compose.yml for a full local or small-prod install
  systemd/          unit files for the agent
  helm/             phase 4
docs/
  PLAN.md           this document
  adr/              architecture decision records, one per significant choice
  api/              generated OpenAPI reference
```

## 8. Delivery phases

Each phase ends with something a user can run and get value from. Estimates assume
two to three engineers and are deliberately rough.

### Phase 0: Foundations (2 weeks)

- Repository scaffolding, Go module, npm workspace, lint and test in CI.
- `docker compose up` brings up Postgres, ClickHouse, server and web UI.
- Migrations framework for both databases; sqlc for Postgres queries.
- Auth: orgs, users, roles, sessions, API keys. Admin creates the first user via CLI.
- OpenAPI spec is the contract; the web client is generated from it.
- Observability of ourselves: the server exports its own metrics into its own
  ClickHouse so we dogfood from day one.

Exit: a logged-in user sees an empty dashboard; CI is green; an ADR documents the
storage choice.

### Phase 1: Uptime monitoring (4 weeks)

- Checks CRUD with all five probe types and assertions.
- Prober binary, assignment protocol, heartbeat, multi-region labels, quorum logic.
- `check_results` schema, writer, availability and latency queries.
- Check list, check detail page with phase-timing chart and recent failures.
- Alert rules of kind "uptime" with `for` duration; incidents; Slack, email and
  webhook channels; simple routes.
- Public status page with components and 90-day bars.

Exit: the team can retire whatever hosted uptime tool it uses today.

### Phase 2: Infrastructure (5 weeks)

- Agent: host and container collectors, config file, systemd unit, auto-update
  check, install script.
- OTLP metrics ingest with cardinality limits; `metrics_raw` plus 5m and 1h rollups.
- Query engine and structured query API with tier selection.
- Hosts overview and host detail pages; dashboard builder with time-series, stat,
  gauge and table panels; saved dashboards.
- Threshold and heartbeat alert rules on metric queries.
- Load generator and the first capacity report against section 6.
- Optional: Prometheus scrape compatibility in the agent for apps that already expose
  `/metrics`.

Exit: every host runs the agent; disk-full and CPU alerts page the right person.

### Phase 3: Applications (6 weeks)

- OTLP logs and traces ingest; `logs` and `spans` schemas; tail sampling for traces.
- Log search with full-text, attribute filters, live tail over WebSocket, and
  log-to-trace linking.
- Trace list, waterfall view, span detail; service overview with request rate,
  error rate and latency percentiles derived from spans.
- Alert rules of kind log-count, error-rate and latency.
- Service map from span parent relationships.
- Correlation: from an alert, jump to the host, the logs and the traces for the same
  window.

Exit: an on-call engineer can go from page to root cause without leaving the product.

### Phase 4: Operational maturity (ongoing)

- On-call schedules with rotations and overrides, escalation policies, acks from
  Slack, SMS and voice.
- Maintenance windows, silences with expiry, alert fatigue reports.
- OIDC login, audit log, per-org retention and limits settings.
- Horizontal split: run ingest, query and evaluator as separate deployments; Helm
  chart; ClickHouse replication; Postgres HA guidance.
- Backups and restore runbook; upgrade path tested in CI.

## 9. Risks and how we handle them

| Risk | Mitigation |
|---|---|
| Three signal types is a lot for a small team to build at once | Phases are sequential and each is shippable alone. Phase 1 alone is a useful product. Resist starting phase 3 before phase 2 is in production use. |
| Writing our own storage would sink the project | We do not. ClickHouse and Postgres carry the storage load; our code is schema, writers and a query translator, all testable. |
| Label cardinality explosion | Hard per-org limits at ingest, visible counters, documented defaults. |
| Prober or ingest becomes a single point of failure | Probers are stateless and horizontal from phase 1. Ingest is behind a load balancer from phase 4. Status page is cached and independent of ClickHouse health. |
| Alert fatigue makes people ignore pages | Grouping, `for` durations, quorum for uptime, flap cooldown and a fatigue report are all in the plan, not afterthoughts. |
| Clock skew across agents | Server stamps receive time and rejects samples more than 10 minutes in the future; UI shows agent clock drift. |
| ClickHouse operational unfamiliarity | Single node in phases 0 to 3, documented backup and upgrade procedures, one person owns learning it, replication deferred to phase 4. |
| Scope creep in the dashboard builder | v1 panels are four types with the structured query. No plugin system, no scripting. |

## 10. Decisions to confirm before Phase 0

1. **ClickHouse plus Postgres, or TimescaleDB alone.** The plan recommends the
   former. Choosing TimescaleDB alone simplifies operations and is fine for phases 1
   and 2, but phase 3 logs and traces will want a columnar store anyway.
2. **React or Svelte** for the UI. React is the default; this is a team preference
   call with no architectural consequence.
3. **ICMP checks** require raw socket capability on probers. Keep them in v1 or drop
   to phase 4.
4. **Prometheus scrape compatibility** in the agent. Cheap to add in phase 2 and
   widens the set of apps that work out of the box. Recommend yes.
5. **Deployment target** for the team's own instance: a single VM with
   `docker compose`, or Kubernetes from the start. The plan assumes the VM; the Helm
   chart arrives in phase 4.

## 11. Immediate next steps

1. Review this document and settle the five decisions above.
2. Write ADR-001 (storage) and ADR-002 (ingest protocol) in `docs/adr/`.
3. Scaffold the repository per section 7 and get `docker compose up` to a login page.
4. Define the OpenAPI spec for checks, incidents and auth as the first contract.
