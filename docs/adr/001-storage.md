# ADR-001: PostgreSQL for control plane, ClickHouse for telemetry

Status: accepted, 2026-10-14

## Context

Monitor stores two very different kinds of data. Control-plane data
(organisations, users, checks, alert rules, incidents, dashboards) is small,
relational and needs transactions. Telemetry (check results, metrics, logs,
spans) is append-only, arrives at thousands of rows per second, is queried by
time range and aggregated, and must expire automatically.

The project rule is to build the monitoring system rather than assemble it from
existing monitoring products, but writing a storage engine is out of scope: it
is the highest-risk component to get right and offers no product
differentiation.

## Options considered

1. PostgreSQL alone (plain, or with TimescaleDB). One database to run. Good for
   metrics and check results at small scale. Poor fit for log search and span
   storage: row-oriented storage compresses badly and full-text over large
   tables needs a separate index.
2. PostgreSQL plus ClickHouse. Two databases to run. ClickHouse's columnar
   storage, materialized-view rollups, TTL and skip indexes cover metrics, logs
   and traces in one engine with 10 to 20x compression on one node.
3. PostgreSQL plus a purpose-built TSDB per signal (a metrics store, a log store,
   a trace store). Three more systems to learn and operate.

## Decision

Option 2. PostgreSQL 16 holds the control plane and alert state. ClickHouse
holds all telemetry. Our code owns the schema, the writers, the rollups and the
query translation, which is where the product lives.

## Consequences

- Two databases in the compose file from day one. The server's readiness probe
  checks both.
- ClickHouse DDL is not transactional, so every migration statement is written
  to be idempotent and a failed migration is re-run after the cause is fixed.
- Phase 0 to 3 run ClickHouse as a single node. Replication is a phase 4
  concern and the schema does not use replicated engines yet; switching to
  them is a table rewrite that phase 4 must plan.
- The team needs one person to own ClickHouse operations (backups, upgrades,
  memory settings). The compose file ships conservative defaults.
