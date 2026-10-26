# ADR-002: OpenTelemetry Protocol (OTLP) as the only ingest protocol

Status: superseded on 2026-10-24 by ADR-003, which moves the product to shared hosting and MySQL

## Context

Monitor receives telemetry from three sources: its own probers, the host
agent and the team's applications. Applications are written in several
languages and already have, or can trivially add, OpenTelemetry SDKs.
Maintaining our own client library in every language would consume a large
share of a small team's capacity and would always lag the OTel SDKs.

## Decision

The server accepts OTLP over gRPC and over HTTP/protobuf for metrics, logs and
traces. The prober and the agent speak OTLP to the server as well, so there
is a single ingest path to validate, rate-limit and test. OTLP is a wire
format, not a monitoring product; using it does not conflict with the
build-from-scratch rule.

Phase 2 adds Prometheus exposition-format scraping to the agent, so services
that already expose `/metrics` work without code changes. The agent converts
scraped samples to OTLP before sending, keeping the server to one protocol.

## Consequences

- Our data model uses OTel vocabulary: resources, instrumentation scopes,
  attributes. The ClickHouse schema stores resource identity and attributes
  as a map.
- The prober and agent depend on the OTel Go SDK for export only; the
  server implements the receiver side from the protobuf definitions and does
  not depend on the OTel Collector.
- We do not accept StatsD, Graphite or InfluxDB line protocol. If a need
  appears, it is served by a small converter in the agent, not by a second
  server-side ingest path.
