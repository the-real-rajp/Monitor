<?php
declare(strict_types=1);

namespace Monitor\Tests;

use Monitor\Clock;
use Monitor\Status\StatusEngine;

final class StatusEngineTest extends TestCase
{
    private function engine(): StatusEngine
    {
        return new StatusEngine($this->db, $this->app->settings);
    }

    private function r(int $ts, ?float $rtt): array
    {
        return ['ts' => Clock::toDb($ts), 'rtt_ms' => $rtt, 'method' => 'icmp'];
    }

    public function testGoesDownAfterThresholdAndRecovers(): void
    {
        $id = $this->createDevice('sw', '10.0.0.2');
        $t = 1_800_000_000;
        $e = $this->engine();

        $e->ingest($id, [$this->r($t, 1.2), $this->r($t + 60, null), $this->r($t + 120, null)], 'test');
        $s = $this->db->one('SELECT * FROM device_status WHERE device_id = ?', [$id]);
        $this->assertSame('up', $s['state'], 'two timeouts are below the threshold of three');
        $this->assertSame(2, (int) $s['consecutive_failures']);

        $e->ingest($id, [$this->r($t + 180, null)], 'test');
        $s = $this->db->one('SELECT * FROM device_status WHERE device_id = ?', [$id]);
        $this->assertSame('down', $s['state']);
        $this->assertSame(Clock::toDb($t + 60), $s['since'], 'outage dated from the first miss');
        $ev = $this->db->one('SELECT * FROM events WHERE device_id = ?', [$id]);
        $this->assertNotNull($ev);
        $this->assertNull($ev['ended_at']);
        $this->assertStringContainsString('3 consecutive timeouts', $ev['detected_by']);

        $e->ingest($id, [$this->r($t + 240, 2.0)], 'test');
        $s = $this->db->one('SELECT * FROM device_status WHERE device_id = ?', [$id]);
        $this->assertSame('up', $s['state']);
        $this->assertSame(0, (int) $s['consecutive_failures']);
        $ev = $this->db->one('SELECT * FROM events WHERE device_id = ?', [$id]);
        $this->assertSame(Clock::toDb($t + 60), $ev['started_at']);
        $this->assertSame(Clock::toDb($t + 240), $ev['ended_at']);
        $this->assertSame(180, (int) $ev['duration_s']);
        $this->assertSame(1, (int) $this->db->value('SELECT COUNT(*) FROM events'));
    }

    public function testBackfillDoesNotMoveStateBackwards(): void
    {
        $id = $this->createDevice('sw', '10.0.0.2');
        $t = 1_800_000_000;
        $e = $this->engine();
        $e->ingest($id, [$this->r($t + 600, 1.0)], 'test');
        // Older timeouts arrive later (agent buffered them).
        $e->ingest($id, [$this->r($t, null), $this->r($t + 60, null), $this->r($t + 120, null)], 'test');
        $s = $this->db->one('SELECT * FROM device_status WHERE device_id = ?', [$id]);
        $this->assertSame('up', $s['state']);
        $this->assertSame(Clock::toDb($t + 600), $s['last_ts']);
        $this->assertSame(4, (int) $this->db->value('SELECT COUNT(*) FROM ping_results WHERE device_id = ?', [$id]), 'history still stored');
        $this->assertSame(0, (int) $this->db->value('SELECT COUNT(*) FROM events'));
    }

    public function testIdempotentOnDuplicateTimestamps(): void
    {
        $id = $this->createDevice('sw', '10.0.0.2');
        $t = 1_800_000_000;
        $e = $this->engine();
        $batch = [$this->r($t, 1.0), $this->r($t + 60, 1.1)];
        $this->assertSame(2, $e->ingest($id, $batch, 'test'));
        $this->assertSame(0, $e->ingest($id, $batch, 'test'));
        $this->assertSame(2, (int) $this->db->value('SELECT COUNT(*) FROM ping_results'));
    }

    public function testMarksDirtyHours(): void
    {
        $id = $this->createDevice('sw', '10.0.0.2');
        $t = 1_800_000_000 - (1_800_000_000 % 3600) + 100; // 100s into an hour
        $this->engine()->ingest($id, [$this->r($t, 1.0), $this->r($t + 3600, 1.0), $this->r($t + 3660, 1.0)], 'test');
        $this->assertSame(2, (int) $this->db->value('SELECT COUNT(*) FROM rollup_dirty WHERE device_id = ?', [$id]));
    }

    public function testMarkStaleWhenAgentSilent(): void
    {
        $a = $this->createAgent();
        $id = $this->createDevice('sw', '10.0.0.2', 'agent', $a['id']);
        $this->engine()->ingest($id, [$this->r(time() - 30, 1.0)], 'test');
        $this->db->exec('UPDATE agents SET last_seen_at = UTC_TIMESTAMP() - INTERVAL 10 MINUTE WHERE id = ?', [$a['id']]);
        $this->assertSame(1, $this->engine()->markStale());
        $this->assertSame('unknown', $this->db->value('SELECT state FROM device_status WHERE device_id = ?', [$id]));
        // A fresh heartbeat plus a result brings it back.
        $this->db->exec('UPDATE agents SET last_seen_at = UTC_TIMESTAMP() WHERE id = ?', [$a['id']]);
        $this->engine()->ingest($id, [$this->r(time(), 1.0)], 'test');
        $this->assertSame('up', $this->db->value('SELECT state FROM device_status WHERE device_id = ?', [$id]));
    }
}
