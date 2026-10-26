# ADR-003: PHP and MySQL on shared hosting, with a Go proxy on-prem

Status: accepted, 2026-10-24. Supersedes ADR-001 and ADR-002.

## Context

The product was narrowed to ping monitoring with a month of history, and the
website will run on an existing Bluehost shared hosting plan with its cPanel
MySQL database. Shared hosting runs PHP and cron, terminates long-running
processes, grants no root, and often blocks raw ICMP and `exec`. The devices
of interest sit inside an office network the website cannot reach.

## Decision

- The website is a PHP 8 application with no framework, using PDO against the
  cPanel MySQL database. Scheduled work runs from a one-minute cPanel cron job
  that must finish well inside its minute.
- MySQL is the only data store. Raw ping results are kept for 7 days; an hourly
  rollup table provides the 30-day history and beyond.
- Pings inside the office are performed by `monitor-agent`, a Go binary on a
  Linux box or Raspberry Pi, which pulls its device list from the website and
  pushes results outbound over HTTPS. It buffers results while the website is
  unreachable.
- Pings of internet-facing devices are performed by the website's cron job
  using `ping` when the host permits it and a TCP connect check otherwise.
- The dashboard is a React application built by CI and committed to a deploy
  branch so cPanel's Git deployment needs no Node toolchain.

## Consequences

- The Go server, PostgreSQL schema, ClickHouse schema and the OpenTelemetry
  ingest path from the previous plan are removed. Their conventions for
  sessions, API keys and error responses are reused in the PHP code.
- Website-side checks cannot run more often than once a minute. Office checks
  can run every 10 seconds through the agent.
- If `exec` is blocked, website-side availability is measured by TCP connect
  rather than ICMP, which the UI must state plainly next to the device.
- Moving to a VPS later is a deployment change, not a rewrite: the PHP
  application and cron job run unchanged there.
