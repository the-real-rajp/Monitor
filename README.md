# Monitor

Self-hosted monitoring for a small team: uptime checks, host and container
metrics, and application metrics, logs and traces, with one alerting engine and
one UI.

- `docs/PLAN.md`: architecture, data model, phases and progress.
- `docs/DEVELOPMENT.md`: how to run, test and extend the code.
- `docs/adr/`: decisions with lasting consequences.
- `deploy/compose/`: a complete single-host install with Docker Compose.

## Status

Phase 0 (foundations) is complete: the server runs, migrates both databases,
authenticates users and API keys, serves the web UI and monitors itself.
Phase 1 (uptime monitoring) is next.

## Quick start

```sh
cd deploy/compose
cp .env.example .env            # set the passwords
docker compose up -d --build
docker compose exec -T server /monitor-server user create \
    --email you@example.com --name "You" --org "Your Org" --password-stdin <<< 'a-long-password'
open http://localhost:8080
```
