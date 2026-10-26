<?php
declare(strict_types=1);

namespace Monitor\Tests;

use Monitor\Clock;
use Monitor\Rollup;
use Monitor\Status\StatusEngine;

final class RollupTest extends TestCase
{
    public function testHourlyAggregatesAndP95(): void
    {
        $id = $this->createDevice('sw', '10.0.0.2');
        $hour = 1_800_000_000 - (1_800_000_000 % 3600);
        $results = [];
        for ($i = 0; $i < 20; $i++) {
            // 18 successes 1..18 ms, 2 timeouts
            $results[] = ['ts' => Clock::toDb($hour + $i * 60), 'rtt_ms' => $i < 18 ? (float) ($i + 1) : null, 'method' => 'icmp'];
        }
        (new StatusEngine($this->db, $this->app->settings))->ingest($id, $results, 'test');
        $n = (new Rollup($this->db, $this->app->settings))->run();
        $this->assertSame(1, $n);
        $row = $this->db->one('SELECT * FROM ping_hourly WHERE device_id = ?', [$id]);
        $this->assertSame(20, (int) $row['sent']);
        $this->assertSame(18, (int) $row['received']);
        $this->assertSame(1.0, (float) $row['rtt_min']);
        $this->assertSame(18.0, (float) $row['rtt_max']);
        $this->assertSame(9.5, (float) $row['rtt_avg']);
        $this->assertSame(18.0, (float) $row['rtt_p95'], 'ceil(0.95*18)=18th value');
        $this->assertSame(0, (int) $this->db->value('SELECT COUNT(*) FROM rollup_dirty'));
    }

    public function testPruneRespectsRetention(): void
    {
        $id = $this->createDevice('sw', '10.0.0.2');
        $now = 1_800_000_000;
        $this->freezeTime($now);
        $this->db->exec('INSERT INTO ping_results (device_id, ts, rtt_ms) VALUES (?, ?, 1), (?, ?, 1)', [
            $id, Clock::toDb($now - 8 * 86400), $id, Clock::toDb($now - 6 * 86400),
        ]);
        $this->db->exec('INSERT INTO ping_hourly (device_id, hour, sent, received) VALUES (?, ?, 1, 1), (?, ?, 1, 1)', [
            $id, Clock::toDb($now - 401 * 86400), $id, Clock::toDb($now - 399 * 86400),
        ]);
        (new Rollup($this->db, $this->app->settings))->prune();
        $this->assertSame(1, (int) $this->db->value('SELECT COUNT(*) FROM ping_results'));
        $this->assertSame(1, (int) $this->db->value('SELECT COUNT(*) FROM ping_hourly'));
    }
}
