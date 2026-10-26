<?php
declare(strict_types=1);

namespace Monitor\Handlers;

use Monitor\App;
use Monitor\Clock;
use Monitor\Http\Request;
use Monitor\Http\Response;

final class HealthHandlers
{
    public const VERSION = '0.1.0';

    public function __construct(private readonly App $app)
    {
    }

    /** GET /api/health: public, no secrets. 503 when the database or cron is unhealthy. */
    public function health(Request $req): Response
    {
        $ok = true;
        $checks = [];
        try {
            $this->app->db->value('SELECT 1');
            $checks['database'] = 'ok';
        } catch (\Throwable $e) {
            $checks['database'] = 'unreachable';
            $ok = false;
        }
        $cron = null;
        if ($checks['database'] === 'ok') {
            $cron = $this->app->db->one('SELECT * FROM cron_runs ORDER BY id DESC LIMIT 1');
            $age = $cron === null ? null : Clock::now() - Clock::fromDb((string) $cron['started_at']);
            if ($cron === null) {
                $checks['cron'] = 'never ran';
                $ok = false;
            } elseif ($age > 180) {
                $checks['cron'] = "last run {$age}s ago";
                $ok = false;
            } elseif ($cron['error'] !== null) {
                $checks['cron'] = 'last run failed';
                $ok = false;
            } else {
                $checks['cron'] = 'ok';
            }
        }
        return Response::json([
            'status'          => $ok ? 'ok' : 'degraded',
            'version'         => self::VERSION,
            'checks'          => $checks,
            'web_ping_method' => $checks['database'] === 'ok' ? $this->app->settings->get('web_ping_method', 'unknown') : null,
            'cron'            => $cron === null ? null : [
                'started_at'  => Clock::iso($cron['started_at']),
                'duration_ms' => $cron['duration_ms'] === null ? null : (int) $cron['duration_ms'],
                'pinged'      => (int) $cron['pinged'],
                'error'       => $cron['error'],
            ],
        ], $ok ? 200 : 503);
    }

    /** GET /install.sh: the proxy install script with this site's URL filled in. */
    public function installScript(Request $req): Response
    {
        $path = __DIR__ . '/../../resources/install.sh';
        $script = is_file($path) ? (string) file_get_contents($path) : "#!/bin/sh\necho 'install script missing on server' >&2\nexit 1\n";
        $script = str_replace('__BASE_URL__', $this->app->baseUrl(), $script);
        return (new Response(200, $script))->withHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
    }
}
