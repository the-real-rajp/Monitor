# Monitor

Ping monitoring with a month of history. A Raspberry Pi or Linux box in the
office pings local devices and reports to a PHP website on Bluehost shared
hosting; the website pings internet-facing devices itself and serves the
dashboard from its MySQL database.

- `docs/PLAN.md`: what we are building, architecture, data model, phases, progress.
- `docs/DEPLOY.md`: putting it on a cPanel account, step by step.
- `docs/DEVELOPMENT.md`: running and testing the three parts locally.
- `docs/adr/`: decisions with lasting consequences.

## Status

Phase 1 is built: website, proxy and dashboard work end to end locally. Next
is the first deployment to the Bluehost account and a tagged release of the
proxy. Phase 2 adds email alerts.

## Quick tour

```sh
# website
cd web && composer install && cp config.example.php config.php   # edit it
php bin/migrate.php && php bin/user.php create --email you@example.com --name You
php -S 127.0.0.1:8000 -t public public/index.php                 # API + dashboard
php bin/cron.php                                                 # the per-minute job

# dashboard
cd ui && npm install && npm run build                            # into web/public

# proxy
make agent && ./bin/monitor-agent -url http://127.0.0.1:8000 -key mon_...
```
