# Deploying Monitor to Bluehost (cPanel shared hosting)

One-time setup takes about twenty minutes. After that, every push to `main`
builds the dashboard in GitHub Actions and publishes a `deploy` branch that
cPanel pulls.

## 1. Database

In cPanel, **MySQL Databases**:

1. Create a database, e.g. `cpuser_monitor`.
2. Create a user, e.g. `cpuser_monitor`, with a long password.
3. Add the user to the database with **All privileges**.

## 2. Subdomain

In **Domains**, create a subdomain such as `monitor.example.com` and note its
document root. We will point it at `/home/cpuser/monitor/public` in step 4.

## 3. Pull the deploy branch

In **Git Version Control**, click **Create**, then:

- Clone URL: `https://github.com/the-real-rajp/monitor.git`
- Repository path: `/home/cpuser/repos/monitor`
- Branch: `deploy`

After the clone, open **Manage › Pull or Deploy** and click **Update from
Remote**, then **Deploy HEAD Commit**. The `.cpanel.yml` on the deploy branch
copies `web/` to `/home/cpuser/monitor` and runs the migrations. The first run
fails at the migration step because there is no config yet; that is expected.
Fix the deploy path first if your username is not `cpuser`:

The `.cpanel.yml` has `DEPLOYPATH=/home/CPANEL_USER/monitor`. Because the
deploy branch is regenerated on every push, do not edit it there. Instead set
the real path once in `deploy/cpanel/.cpanel.yml` on `main` and push.

## 4. Configuration

Over SSH or the cPanel **Terminal**:

```sh
cd /home/cpuser/monitor
cp config.example.php config.php
nano config.php            # database credentials, base_url, timezone
chmod 600 config.php
mkdir -p storage && chmod 750 storage
php bin/migrate.php
php bin/user.php create --email you@example.com --name "You" --role admin
```

`config.php` sits outside `public/`, is never in git, and survives deploys.

Now point the subdomain's document root at `/home/cpuser/monitor/public`
(**Domains › Manage › Document Root**). Visit the site; you should see the
login page.

## 5. Cron

In **Cron Jobs**, add a job that runs every minute:

```
* * * * * /usr/local/bin/php /home/cpuser/monitor/bin/cron.php >> /home/cpuser/monitor/storage/cron.log 2>&1
```

Use the PHP binary path cPanel shows (often `/usr/local/bin/php` or
`/usr/local/bin/ea-php83`). After a minute, `/api/health` should report
`"cron": "ok"` and `web_ping_method` as `icmp` or `tcp`. If it says `tcp`, the
host blocks ICMP: give each website-pinged device a TCP port (443 on a
firewall) on the Devices page.

## 6. The proxy

In the dashboard, **Proxies › Add a proxy**. Run the install command it shows
on the Raspberry Pi or Linux box. The command downloads the binary for the
CPU from this repository's GitHub releases, so a tag like `v0.1.0` must exist
(the `release` workflow builds it). Then assign devices to the proxy.

To run the proxy as a VM on Nutanix AHV or VMware instead, see
`docs/PROXY-VM.md`: the same dialog gives you a first-boot file for a stock
Ubuntu cloud image.

## Updating

Push to `main`. Within a minute or so the `deploy` workflow publishes a new
commit on the `deploy` branch. That is as far as GitHub goes: nothing reaches
the host until cPanel pulls that branch. Migrations run as part of each
deploy.

### By hand

In cPanel's Git Version Control, **Manage › Pull or Deploy**: **Update from
Remote**, then **Deploy HEAD Commit**.

### Automatically

cPanel only deploys by itself when commits are pushed *to* a repository it
hosts. This one is a clone that pulls from GitHub, so there is no setting to
switch on. A second cron job gets the same result: it pulls the deploy branch
and deploys only when something changed.

In **Cron Jobs**, add a job that runs every five minutes:

```
*/5 * * * * cd /home/cpuser/repos/monitor && old=$(git rev-parse HEAD) && git pull -q --ff-only && [ "$old" != "$(git rev-parse HEAD)" ] && /usr/bin/uapi VersionControlDeployment create repository_root=/home/cpuser/repos/monitor
```

- Use the repository path from step 3, as Git Version Control shows it.
- `uapi` is at `/usr/local/cpanel/bin/uapi` on some hosts; `which uapi` in the
  cPanel **Terminal** prints the path.
- Run the command once by hand in the Terminal first. It prints nothing when
  there is nothing new.

After a deploy, **Settings › About this install** shows the build: the first
12 characters of the commit on `main` it was built from.

## Troubleshooting

| Symptom | Check |
|---|---|
| Blank page or 500 | `tail storage/cron.log` and the cPanel error log; PHP must be 8.1 or newer with `pdo_mysql` |
| Login page loads, API calls fail | `.htaccess` rewrite needs `mod_rewrite`; confirm the document root is `monitor/public` |
| `/api/health` says cron never ran | Cron job path or PHP binary wrong; run the command by hand over SSH |
| Devices show unknown | Proxy offline (check the Proxies page) or website pinger failing (`web_pinger.last_error` in `/api/overview`) |
| Proxy says `invalid agent key` | Key was rotated or revoked; re-run the install command with the new key |
