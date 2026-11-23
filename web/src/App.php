<?php
declare(strict_types=1);

namespace Monitor;

use Monitor\Auth\AgentKeys;
use Monitor\Auth\Principal;
use Monitor\Auth\Sessions;
use Monitor\Handlers\AgentApiHandlers;
use Monitor\Handlers\AgentHandlers;
use Monitor\Handlers\AuthHandlers;
use Monitor\Handlers\DeviceHandlers;
use Monitor\Handlers\GroupHandlers;
use Monitor\Handlers\HealthHandlers;
use Monitor\Handlers\OverviewHandlers;
use Monitor\Http\Auth;
use Monitor\Http\HttpError;
use Monitor\Http\Request;
use Monitor\Http\Response;
use Monitor\Http\Router;

/**
 * Wires configuration, database and routes, and runs the request pipeline:
 * security headers, authentication, CSRF check, route auth, handler, and
 * uniform error responses.
 */
final class App
{
    public readonly Settings $settings;
    public readonly Sessions $sessions;
    private ?Router $router = null;

    /** @param array<string,mixed> $config */
    public function __construct(public readonly array $config, public readonly Db $db)
    {
        $this->settings = new Settings($db);
        $this->sessions = new Sessions($db, (int) ($config['session_ttl'] ?? 30 * 86400));
        date_default_timezone_set('UTC');
    }

    public static function fromConfigFile(string $path): self
    {
        if (!is_file($path)) {
            throw new \RuntimeException("config file not found: $path (copy config.example.php)");
        }
        $config = require $path;
        if (!is_array($config)) {
            throw new \RuntimeException("config file must return an array: $path");
        }
        return new self($config, Db::connect($config['db']));
    }

    public function baseUrl(): string
    {
        return rtrim((string) ($this->config['base_url'] ?? 'http://localhost:8000'), '/');
    }

    public function secureCookies(): bool
    {
        return str_starts_with($this->baseUrl(), 'https://');
    }

    public function timezone(): \DateTimeZone
    {
        try {
            return new \DateTimeZone((string) ($this->config['timezone'] ?? 'UTC'));
        } catch (\Exception) {
            return new \DateTimeZone('UTC');
        }
    }

    public function router(): Router
    {
        if ($this->router !== null) {
            return $this->router;
        }
        $r = new Router();
        $auth = new AuthHandlers($this);
        $overview = new OverviewHandlers($this);
        $devices = new DeviceHandlers($this);
        $groups = new GroupHandlers($this);
        $agents = new AgentHandlers($this);
        $agentApi = new AgentApiHandlers($this);
        $health = new HealthHandlers($this);

        $r->add('GET', '/api/health', $health->health(...), Auth::None);
        $r->add('GET', '/install.sh', $health->installScript(...), Auth::None);

        $r->add('POST', '/api/auth/login', $auth->login(...), Auth::None);
        $r->add('POST', '/api/auth/logout', $auth->logout(...), Auth::Session);
        $r->add('GET', '/api/auth/me', $auth->me(...), Auth::Session);
        $r->add('POST', '/api/auth/password', $auth->changePassword(...), Auth::Session);

        $r->add('GET', '/api/overview', $overview->overview(...), Auth::Session);

        $r->add('GET', '/api/devices', $devices->list(...), Auth::Session);
        $r->add('POST', '/api/devices', $devices->create(...), Auth::Admin);
        $r->add('POST', '/api/devices/reorder', $devices->reorder(...), Auth::Admin);
        $r->add('GET', '/api/devices/{id}', $devices->get(...), Auth::Session);
        $r->add('PATCH', '/api/devices/{id}', $devices->update(...), Auth::Admin);
        $r->add('DELETE', '/api/devices/{id}', $devices->delete(...), Auth::Admin);
        $r->add('GET', '/api/devices/{id}/history', $devices->history(...), Auth::Session);
        $r->add('GET', '/api/devices/{id}/days', $devices->days(...), Auth::Session);
        $r->add('GET', '/api/devices/{id}/events', $devices->events(...), Auth::Session);

        $r->add('GET', '/api/groups', $groups->list(...), Auth::Session);
        $r->add('POST', '/api/groups', $groups->create(...), Auth::Admin);
        $r->add('PATCH', '/api/groups/{id}', $groups->update(...), Auth::Admin);
        $r->add('DELETE', '/api/groups/{id}', $groups->delete(...), Auth::Admin);

        $r->add('GET', '/api/agents', $agents->list(...), Auth::Session);
        $r->add('POST', '/api/agents', $agents->create(...), Auth::Admin);
        $r->add('PATCH', '/api/agents/{id}', $agents->update(...), Auth::Admin);
        $r->add('DELETE', '/api/agents/{id}', $agents->delete(...), Auth::Admin);
        $r->add('POST', '/api/agents/{id}/rotate', $agents->rotate(...), Auth::Admin);

        $r->add('GET', '/api/agent/devices', $agentApi->devices(...), Auth::Agent);
        $r->add('POST', '/api/agent/results', $agentApi->results(...), Auth::Agent);
        $r->add('POST', '/api/agent/heartbeat', $agentApi->heartbeat(...), Auth::Agent);

        return $this->router = $r;
    }

    public function handle(Request $req): Response
    {
        try {
            $res = $this->dispatch($req);
        } catch (HttpError $e) {
            $res = Response::error($e->status, $e->errorCode, $e->getMessage());
        } catch (\Throwable $e) {
            error_log(sprintf('monitor: %s %s: %s in %s:%d', $req->method, $req->path, $e->getMessage(), $e->getFile(), $e->getLine()));
            $res = Response::error(500, 'internal', 'internal error');
        }
        $res->withHeader('X-Content-Type-Options', 'nosniff')
            ->withHeader('X-Frame-Options', 'DENY')
            ->withHeader('Referrer-Policy', 'same-origin');
        if (str_starts_with($req->path, '/api/')) {
            $res->withHeader('Cache-Control', 'no-store');
        }
        return $res;
    }

    private function dispatch(Request $req): Response
    {
        $mismatch = false;
        $route = $this->router()->match($req, $mismatch);
        if ($route === null) {
            if (str_starts_with($req->path, '/api/')) {
                throw $mismatch ? new HttpError(405, 'method_not_allowed', 'method not allowed') : HttpError::notFound('no such endpoint');
            }
            return $this->spa($req);
        }

        $this->authenticate($req);
        $this->csrf($req);

        $p = $req->principal;
        switch ($route->auth) {
            case Auth::None:
                break;
            case Auth::Session:
                if ($p?->user === null) {
                    throw HttpError::unauthorized('login required');
                }
                break;
            case Auth::Admin:
                if ($p?->user === null) {
                    throw HttpError::unauthorized('login required');
                }
                if (!$p->isAdmin()) {
                    throw HttpError::forbidden('admin role required');
                }
                break;
            case Auth::Agent:
                if ($p?->agent === null) {
                    throw HttpError::unauthorized('agent key required');
                }
                break;
        }
        return ($route->handler)($req);
    }

    /** Resolves the session cookie or bearer agent key, if any. */
    private function authenticate(Request $req): void
    {
        $token = $req->cookie(Sessions::COOKIE);
        if ($token !== null && $token !== '') {
            $user = $this->sessions->user($token);
            if ($user !== null) {
                $req->principal = Principal::forUser($user, $token);
                return;
            }
        }
        $authz = $req->header('authorization');
        if ($authz !== null && str_starts_with($authz, 'Bearer ')) {
            $key = trim(substr($authz, 7));
            $prefix = AgentKeys::prefix($key);
            if ($prefix === null) {
                throw HttpError::unauthorized('malformed agent key');
            }
            $agent = $this->db->one('SELECT * FROM agents WHERE key_prefix = ? AND revoked_at IS NULL', [$prefix]);
            if ($agent === null || !AgentKeys::matches($key, (string) $agent['key_hash'])) {
                throw HttpError::unauthorized('invalid agent key');
            }
            $req->principal = Principal::forAgent($agent);
        }
    }

    /**
     * Rejects state-changing browser requests from another origin. Agent
     * requests carry no cookie and are exempt. SameSite=Lax on the cookie is
     * the second layer.
     */
    private function csrf(Request $req): void
    {
        if (in_array($req->method, ['GET', 'HEAD', 'OPTIONS'], true) || $req->principal?->user === null) {
            return;
        }
        $src = $req->header('origin') ?? $req->header('referer');
        if ($src === null) {
            $sfs = $req->header('sec-fetch-site');
            if ($sfs !== null && $sfs !== 'same-origin' && $sfs !== 'none') {
                throw HttpError::forbidden('cross-site request rejected');
            }
            return;
        }
        $expected = parse_url($this->baseUrl(), PHP_URL_HOST);
        $got = parse_url($src, PHP_URL_HOST);
        if ($expected === null || $got === null || strcasecmp((string) $expected, (string) $got) !== 0) {
            throw HttpError::forbidden('cross-site request rejected');
        }
    }

    /** Serves the dashboard's index.html for any non-API path (client-side routing). */
    private function spa(Request $req): Response
    {
        if ($req->method !== 'GET' && $req->method !== 'HEAD') {
            throw HttpError::notFound();
        }
        $index = __DIR__ . '/../public/index.html';
        if (!is_file($index)) {
            return Response::html(
                '<!doctype html><meta charset="utf-8"><title>Monitor</title><body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">'
                . '<h1>Monitor API is running</h1><p>The dashboard has not been built into <code>public/</code>. '
                . 'See docs/DEVELOPMENT.md.</p><p>Health: <a href="/api/health">/api/health</a></p>',
            );
        }
        return Response::html((string) file_get_contents($index))->withHeader('Cache-Control', 'no-cache');
    }
}
