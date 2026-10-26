<?php
declare(strict_types=1);

namespace Monitor\Tests;

use Monitor\Clock;

final class ApiTest extends TestCase
{
    public function testLoginLogoutMe(): void
    {
        $this->createUser();
        $r = $this->request('GET', '/api/auth/me');
        $this->assertSame(401, $r->status);

        $r = $this->request('POST', '/api/auth/login', ['email' => 'admin@test.local', 'password' => 'wrong-password-xx']);
        $this->assertSame(401, $r->status);
        $this->assertSame('invalid_credentials', $this->json($r)['error']['code']);

        $r = $this->request('POST', '/api/auth/login', ['email' => 'ADMIN@test.local', 'password' => 'correct-horse-battery']);
        $this->assertSame(200, $r->status, $r->body);
        $cookie = $this->sessionCookie($r);
        [, , $opts] = $r->cookies()[0];
        $this->assertTrue($opts['httponly']);
        $this->assertTrue($opts['secure'], 'https base_url gives Secure cookies');

        $r = $this->request('GET', '/api/auth/me', null, [], $cookie);
        $this->assertSame(200, $r->status);
        $this->assertSame('admin', $this->json($r)['user']['role']);

        $r = $this->request('POST', '/api/auth/logout', null, [], $cookie);
        $this->assertSame(204, $r->status);
        $r = $this->request('GET', '/api/auth/me', null, [], $cookie);
        $this->assertSame(401, $r->status);
    }

    public function testLoginRateLimit(): void
    {
        $this->createUser();
        $last = 0;
        for ($i = 0; $i < 12; $i++) {
            $last = $this->request('POST', '/api/auth/login', ['email' => 'admin@test.local', 'password' => 'nope-nope-nope'])->status;
        }
        $this->assertSame(429, $last);
    }

    public function testCsrfRejectsCrossOrigin(): void
    {
        $this->createUser();
        $cookie = $this->login();
        $r = $this->request('POST', '/api/groups', ['name' => 'x'], ['origin' => 'https://evil.test'], $cookie);
        $this->assertSame(403, $r->status);
        $r = $this->request('POST', '/api/groups', ['name' => 'x'], [], $cookie);
        $this->assertSame(201, $r->status);
    }

    public function testViewerCannotManage(): void
    {
        $this->createUser('v@test.local', 'viewer');
        $cookie = $this->login('v@test.local');
        $this->assertSame(403, $this->request('POST', '/api/groups', ['name' => 'x'], [], $cookie)->status);
        $this->assertSame(200, $this->request('GET', '/api/overview', null, [], $cookie)->status);
    }

    public function testDeviceValidationAndCrud(): void
    {
        $this->createUser();
        $cookie = $this->login();
        $agent = $this->createAgent();

        $bad = fn (array $body) => $this->request('POST', '/api/devices', $body, [], $cookie);
        $this->assertSame(400, $bad(['name' => 'x', 'host' => 'bad host!', 'source' => 'agent', 'agent_id' => $agent['id']])->status);
        $this->assertSame(400, $bad(['name' => 'x', 'host' => '10.0.0.1', 'source' => 'agent'])->status, 'agent source needs agent_id');
        $this->assertSame(400, $bad(['name' => 'x', 'host' => '10.0.0.1', 'source' => 'web', 'interval_s' => 10])->status, 'web source min 60s');
        $this->assertSame(400, $bad(['name' => 'x', 'host' => '10.0.0.1', 'source' => 'agent', 'agent_id' => $agent['id'], 'bogus' => 1])->status);

        $r = $bad(['name' => 'Core switch', 'host' => '10.0.0.2', 'source' => 'agent', 'agent_id' => $agent['id'], 'interval_s' => 30]);
        $this->assertSame(201, $r->status, $r->body);
        $d = $this->json($r);
        $this->assertSame('unknown', $d['status']['state']);

        $r = $this->request('PATCH', '/api/devices/' . $d['id'], ['name' => 'Core SW', 'enabled' => false], [], $cookie);
        $this->assertSame(200, $r->status, $r->body);
        $this->assertSame('Core SW', $this->json($r)['name']);
        $this->assertFalse($this->json($r)['enabled']);

        $r = $this->request('GET', '/api/devices/999999', null, [], $cookie);
        $this->assertSame(404, $r->status);
        $r = $this->request('GET', '/api/devices/not-an-id', null, [], $cookie);
        $this->assertSame(404, $r->status);

        $this->assertSame(204, $this->request('DELETE', '/api/devices/' . $d['id'], null, [], $cookie)->status);
        $this->assertSame(0, (int) $this->db->value('SELECT COUNT(*) FROM device_status'));
    }

    public function testAgentFlow(): void
    {
        $agent = $this->createAgent('Office');
        $other = $this->createAgent('Other');
        $mine = $this->createDevice('sw', '10.0.0.2', 'agent', $agent['id'], 30);
        $theirs = $this->createDevice('x', '10.0.0.9', 'agent', $other['id'], 30);
        $auth = ['authorization' => 'Bearer ' . $agent['key']];

        $r = $this->request('GET', '/api/agent/devices', null, ['authorization' => 'Bearer garbage']);
        $this->assertSame(401, $r->status);
        $r = $this->request('GET', '/api/agent/devices', null, ['authorization' => 'Bearer ' . substr($agent['key'], 0, -1) . 'f']);
        $this->assertSame(401, $r->status, 'tampered key');

        $r = $this->request('GET', '/api/agent/devices', null, $auth);
        $this->assertSame(200, $r->status, $r->body);
        $list = $this->json($r)['devices'];
        $this->assertCount(1, $list);
        $this->assertSame($mine, $list[0]['id']);
        $etag = $r->header('ETag');
        $this->assertNotNull($etag);
        $r = $this->request('GET', '/api/agent/devices', null, $auth + ['if-none-match' => $etag]);
        $this->assertSame(304, $r->status);

        $now = time();
        $r = $this->request('POST', '/api/agent/results', ['results' => [
            ['device_id' => $mine, 'ts' => $now - 60, 'rtt_ms' => 1.5],
            ['device_id' => $mine, 'ts' => gmdate('c', $now - 30), 'rtt_ms' => null],
            ['device_id' => $theirs, 'ts' => $now, 'rtt_ms' => 1.0],   // not mine
            ['device_id' => $mine, 'ts' => $now + 3600, 'rtt_ms' => 1.0], // future
        ], 'queue_depth' => 4], $auth);
        $this->assertSame(200, $r->status, $r->body);
        $this->assertSame(['accepted' => 2, 'stored' => 2, 'rejected' => 2], $this->json($r));
        $this->assertSame(0, (int) $this->db->value('SELECT COUNT(*) FROM ping_results WHERE device_id = ?', [$theirs]));
        $this->assertSame(4, (int) $this->db->value('SELECT queue_depth FROM agents WHERE id = ?', [$agent['id']]));

        $r = $this->request('POST', '/api/agent/heartbeat', ['version' => 'v0.1.0', 'uptime_s' => 10, 'queue_depth' => 0], $auth);
        $this->assertSame(200, $r->status);
        $this->assertSame('v0.1.0', $this->db->value('SELECT version FROM agents WHERE id = ?', [$agent['id']]));

        // Agent keys cannot use browser endpoints.
        $this->assertSame(401, $this->request('GET', '/api/overview', null, $auth)->status);
    }

    public function testOverviewHistoryDaysEvents(): void
    {
        $this->createUser();
        $cookie = $this->login();
        $agent = $this->createAgent();
        $id = $this->createDevice('sw', '10.0.0.2', 'agent', $agent['id'], 60);
        $this->db->exec('UPDATE agents SET last_seen_at = UTC_TIMESTAMP() WHERE id = ?', [$agent['id']]);
        $now = time() - (time() % 60);
        $results = [];
        for ($i = 120; $i >= 1; $i--) {
            $results[] = ['device_id' => $id, 'ts' => $now - $i * 60, 'rtt_ms' => $i >= 50 && $i <= 52 ? null : 2.0 + ($i % 3)];
        }
        $r = $this->request('POST', '/api/agent/results', ['results' => $results], ['authorization' => 'Bearer ' . $agent['key']]);
        $this->assertSame(200, $r->status, $r->body);
        (new \Monitor\Rollup($this->db, $this->app->settings))->run();

        $o = $this->json($this->request('GET', '/api/overview', null, [], $cookie));
        $this->assertSame(1, $o['summary']['devices']);
        $this->assertSame(1, $o['summary']['up']);
        $this->assertSame(1, $o['summary']['outages_30d']);
        $dev = $o['groups'][0]['devices'][0];
        $this->assertSame('up', $dev['state']);
        $this->assertCount(60, $dev['spark']);
        $this->assertEqualsWithDelta(97.5, $dev['uptime_24h'], 0.01);
        $this->assertTrue($o['agents'][0]['online']);

        $h = $this->json($this->request('GET', '/api/devices/' . $id . '/history', null, [], $cookie, ['range' => '1h']));
        $this->assertSame('raw', $h['resolution']);
        $this->assertCount(59, $h['points']);
        $h = $this->json($this->request('GET', '/api/devices/' . $id . '/history', null, [], $cookie, ['range' => '24h']));
        $this->assertSame('minute', $h['resolution']);
        $this->assertCount(120, $h['points']);
        $this->assertSame(1, $h['summary']['outages']);
        $this->assertSame(180, $h['summary']['longest_outage_s']);
        $h = $this->json($this->request('GET', '/api/devices/' . $id . '/history', null, [], $cookie, ['range' => '30d']));
        $this->assertSame('hour', $h['resolution']);
        $this->assertGreaterThanOrEqual(2, count($h['points']));
        $this->assertSame(400, $this->request('GET', '/api/devices/' . $id . '/history', null, [], $cookie, ['range' => '1y'])->status);

        $d = $this->json($this->request('GET', '/api/devices/' . $id . '/days', null, [], $cookie, ['days' => '30']));
        $this->assertCount(30, $d['days']);
        $this->assertSame(120, array_sum(array_column($d['days'], 'sent')));
        $this->assertSame(1, array_sum(array_column($d['days'], 'outages')));

        $e = $this->json($this->request('GET', '/api/devices/' . $id . '/events', null, [], $cookie));
        $this->assertCount(1, $e['events']);
        $this->assertSame(180, $e['events'][0]['duration_s']);
        $this->assertFalse($e['events'][0]['ongoing']);
    }

    public function testHealthAndSpaFallback(): void
    {
        $r = $this->request('GET', '/api/health');
        $this->assertSame(503, $r->status, 'cron never ran');
        $this->db->exec('INSERT INTO cron_runs (started_at, finished_at, duration_ms) VALUES (UTC_TIMESTAMP(), UTC_TIMESTAMP(), 5)');
        $r = $this->request('GET', '/api/health');
        $this->assertSame(200, $r->status);
        $this->assertSame('ok', $this->json($r)['checks']['cron']);

        $r = $this->request('GET', '/api/nope');
        $this->assertSame(404, $r->status);
        $this->assertSame('no-store', $r->header('Cache-Control'));
        $r = $this->request('GET', '/devices/12');
        $this->assertSame(200, $r->status);
        $this->assertStringContainsString('text/html', (string) $r->header('Content-Type'));
    }
}
