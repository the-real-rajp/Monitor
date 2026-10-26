# Monitor

Ping monitoring with a month of history. A Raspberry Pi or Linux box in the
office pings local devices and reports to a PHP website on Bluehost shared
hosting; the website pings internet-facing devices itself and serves the
dashboard from its MySQL database.

- `docs/PLAN.md`: what we are building, architecture, data model, phases.
- `docs/adr/`: decisions with lasting consequences.

## Status

Planning for Phase 1 is complete. The multi-signal Phase 0 code that preceded
this design was removed on 2026-10-24; see `docs/adr/003-shared-hosting.md`.
