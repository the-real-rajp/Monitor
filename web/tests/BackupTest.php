<?php
declare(strict_types=1);

namespace Monitor\Tests;

use Monitor\Backup;

final class BackupTest extends \PHPUnit\Framework\TestCase
{
    private string $dir;

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/monitor-backup-test-' . bin2hex(random_bytes(4));
        mkdir($this->dir, 0700);
    }

    protected function tearDown(): void
    {
        foreach (glob($this->dir . '/{,.}*', GLOB_BRACE) ?: [] as $f) {
            if (is_file($f)) {
                unlink($f);
            }
        }
        @rmdir($this->dir);
    }

    public function testParsesHostPortAndSocketDsns(): void
    {
        $this->assertSame(
            ['host' => '127.0.0.1', 'port' => 3307, 'socket' => null, 'dbname' => 'cpuser_monitor'],
            Backup::parseDsn('mysql:host=127.0.0.1;port=3307;dbname=cpuser_monitor;charset=utf8mb4'),
        );
        $this->assertSame(
            ['host' => null, 'port' => null, 'socket' => '/tmp/mysql.sock', 'dbname' => 'm'],
            Backup::parseDsn('mysql:unix_socket=/tmp/mysql.sock;dbname=m'),
        );
    }

    public function testRejectsDsnsItCannotBackUp(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        Backup::parseDsn('mysql:host=localhost');
    }

    public function testPruneKeepsTheNewest(): void
    {
        foreach (['20261101-030000', '20261103-030000', '20261102-030000', '20261104-030000'] as $stamp) {
            touch("{$this->dir}/monitor-$stamp.sql.gz");
        }
        touch("{$this->dir}/notes.txt");
        $backup = new Backup([], $this->dir, 2);
        $removed = array_map('basename', $backup->prune());
        sort($removed);
        $this->assertSame(['monitor-20261101-030000.sql.gz', 'monitor-20261102-030000.sql.gz'], $removed);
        $this->assertSame(
            ['monitor-20261104-030000.sql.gz', 'monitor-20261103-030000.sql.gz'],
            array_map('basename', $backup->files()),
        );
        $this->assertFileExists("{$this->dir}/notes.txt");
    }

    public function testAFailedDumpLeavesNothingBehind(): void
    {
        $backup = new Backup(['dsn' => 'mysql:host=127.0.0.1;dbname=x', 'user' => 'u', 'password' => 'p'], $this->dir, 2, '/nonexistent/mysqldump');
        try {
            $backup->run();
            $this->fail('expected the dump to fail');
        } catch (\RuntimeException $e) {
            $this->assertStringContainsString('mysqldump', $e->getMessage());
        }
        $left = array_filter(glob($this->dir . '/{,.}*', GLOB_BRACE) ?: [], 'is_file');
        $this->assertSame([], array_values($left), 'no partial dump or option file remains');
    }

    public function testDumpsTheTestDatabase(): void
    {
        $dsn = getenv('MONITOR_TEST_DSN');
        if ($dsn === false || $dsn === '') {
            $this->markTestSkipped('MONITOR_TEST_DSN not set');
        }
        if (trim((string) shell_exec('command -v mysqldump')) === '') {
            $this->markTestSkipped('mysqldump not installed');
        }
        $backup = new Backup(
            ['dsn' => $dsn, 'user' => (string) getenv('MONITOR_TEST_USER'), 'password' => (string) getenv('MONITOR_TEST_PASSWORD')],
            $this->dir,
            1,
        );
        $first = $backup->run(1_800_000_000);
        $second = $backup->run(1_800_000_060);
        $this->assertFileDoesNotExist($first, 'keep=1 removes the older backup');
        $this->assertSame([$second], $backup->files());
        $this->assertSame('0600', substr(sprintf('%o', fileperms($second)), -4));
        $sql = (string) gzdecode((string) file_get_contents($second));
        $this->assertStringContainsString('CREATE TABLE `devices`', $sql);
        $this->assertStringContainsString('CREATE TABLE `ping_results`', $sql);
    }
}
