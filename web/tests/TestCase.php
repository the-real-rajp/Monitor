<?php
declare(strict_types=1);

namespace Monitor\Tests;

use Monitor\App;
use Monitor\Clock;
use Monitor\Db;
use Monitor\Http\Request;
use Monitor\Http\Response;
use Monitor\Migrator;

/**
 * Integration tests run against a real MySQL/MariaDB database named by the
 * MONITOR_TEST_* environment variables. The schema is migrated once per
 * process and every table is truncated before each test.
 */
abstract class TestCase extends \PHPUnit\Framework\TestCase
{
    private static ?Db $shared = null;
    protected Db $db;
    protected App $app;

    protected function setUp(): void
    {
        $dsn = getenv('MONITOR_TEST_DSN');
        if ($dsn === false || $dsn === '') {
            $this->markTestSkipped('MONITOR_TEST_DSN not set');
        }
        if (self::$shared === null) {
            self::$shared = Db::connect(['dsn' => $dsn, 'user' => (string) getenv('MONITOR_TEST_USER'), 'password' => (string) getenv('MONITOR_TEST_PASSWORD')]);
            (new Migrator(self::$shared, __DIR__ . '/../migrations'))->run();
        }
        $this->db = self::$shared;
        $this->db->pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
        foreach (['users', 'sessions', 'agents', 'device_groups', 'devices', 'ping_results', 'ping_hourly', 'device_status', 'events', 'rollup_dirty', 'login_attempts', 'cron_runs'] as $t) {
            $this->db->pdo->exec("TRUNCATE TABLE $t");
        }
        $this->db->pdo->exec('SET FOREIGN_KEY_CHECKS = 1');
        $this->db->exec("UPDATE settings SET `value` = '3' WHERE `key` = 'down_threshold'");
        $this->db->exec("UPDATE settings SET `value` = 'unknown' WHERE `key` = 'web_ping_method'");
        Clock::$now = null;
        $this->app = new App([
            'db' => [], 'base_url' => 'https://monitor.test', 'timezone' => 'UTC', 'session_ttl' => 3600,
        ], $this->db);
    }

    protected function tearDown(): void
    {
        Clock::$now = null;
    }

    protected function freezeTime(int $ts): void
    {
        Clock::$now = fn () => $ts;
    }

    protected function createAgent(string $name = 'Office'): array
    {
        $k = \Monitor\Auth\AgentKeys::generate();
        $this->db->exec('INSERT INTO agents (name, key_prefix, key_hash) VALUES (?, ?, ?)', [$name, $k['prefix'], $k['hash']]);
        return ['id' => $this->db->lastId(), 'key' => $k['key']];
    }

    protected function createDevice(string $name, string $host, string $source = 'agent', ?int $agentId = null, int $interval = 60, ?int $port = null): int
    {
        $this->db->exec(
            'INSERT INTO devices (name, host, source, agent_id, interval_s, tcp_fallback_port) VALUES (?, ?, ?, ?, ?, ?)',
            [$name, $host, $source, $agentId, $interval, $port],
        );
        $id = $this->db->lastId();
        $this->db->exec('INSERT INTO device_status (device_id) VALUES (?)', [$id]);
        return $id;
    }

    protected function createUser(string $email = 'admin@test.local', string $role = 'admin', string $password = 'correct-horse-battery'): int
    {
        return (new \Monitor\Users($this->db))->create($email, 'Test ' . $role, $role, $password);
    }

    /** @param array<string,string> $headers */
    protected function request(string $method, string $path, mixed $body = null, array $headers = [], array $cookies = [], array $query = []): Response
    {
        $h = ['origin' => 'https://monitor.test'];
        foreach ($headers as $k => $v) {
            $h[strtolower($k)] = $v;
        }
        $req = new Request($method, $path, $query, $h, $cookies, $body === null ? '' : json_encode($body, JSON_THROW_ON_ERROR), '203.0.113.5');
        return $this->app->handle($req);
    }

    protected function json(Response $r): array
    {
        return $r->body === '' ? [] : json_decode($r->body, true, 512, JSON_THROW_ON_ERROR);
    }

    protected function sessionCookie(Response $r): array
    {
        foreach ($r->cookies() as [$name, $value]) {
            if ($name === \Monitor\Auth\Sessions::COOKIE && $value !== '') {
                return [$name => $value];
            }
        }
        $this->fail('no session cookie set');
    }

    protected function login(string $email = 'admin@test.local', string $password = 'correct-horse-battery'): array
    {
        $r = $this->request('POST', '/api/auth/login', ['email' => $email, 'password' => $password]);
        $this->assertSame(200, $r->status, $r->body);
        return $this->sessionCookie($r);
    }
}
