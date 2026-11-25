<?php
declare(strict_types=1);

namespace Monitor;

/**
 * Nightly database backup: a gzipped mysqldump in a directory outside the
 * document root, keeping the newest N files. Run by bin/backup.php from cron.
 *
 * The password goes to mysqldump in a private option file, never on the
 * command line, so it does not show up in the host's process list.
 */
final class Backup
{
    private const PREFIX = 'monitor-';
    private const SUFFIX = '.sql.gz';

    /**
     * @param array{dsn?:string,user?:string,password?:string} $db the 'db' block of config.php
     */
    public function __construct(
        private readonly array $db,
        private readonly string $dir,
        private readonly int $keep = 14,
        private readonly string $mysqldump = 'mysqldump',
    ) {
        if ($keep < 1) {
            throw new \InvalidArgumentException('backup keep must be at least 1');
        }
    }

    /**
     * Connection details from a PDO MySQL DSN such as
     * "mysql:host=localhost;port=3306;dbname=monitor;charset=utf8mb4".
     *
     * @return array{host:?string,port:?int,socket:?string,dbname:string}
     */
    public static function parseDsn(string $dsn): array
    {
        if (!str_starts_with($dsn, 'mysql:')) {
            throw new \InvalidArgumentException('backup only supports mysql: DSNs');
        }
        $parts = [];
        foreach (explode(';', substr($dsn, 6)) as $pair) {
            if (str_contains($pair, '=')) {
                [$k, $v] = explode('=', $pair, 2);
                $parts[trim($k)] = trim($v);
            }
        }
        if (($parts['dbname'] ?? '') === '') {
            throw new \InvalidArgumentException('DSN has no dbname');
        }
        return [
            'host'   => $parts['host'] ?? null,
            'port'   => isset($parts['port']) ? (int) $parts['port'] : null,
            'socket' => $parts['unix_socket'] ?? null,
            'dbname' => $parts['dbname'],
        ];
    }

    /** Dump the database and prune old backups. Returns the path of the new file. */
    public function run(?int $now = null): string
    {
        $conn = self::parseDsn((string) ($this->db['dsn'] ?? ''));
        if (!is_dir($this->dir) && !mkdir($this->dir, 0700, true) && !is_dir($this->dir)) {
            throw new \RuntimeException("cannot create backup directory: {$this->dir}");
        }
        $final = $this->dir . '/' . self::PREFIX . gmdate('Ymd-His', $now ?? time()) . self::SUFFIX;
        $partial = $final . '.part';
        $options = $this->writeOptionFile($conn);
        try {
            $this->dump($options, $conn['dbname'], $partial);
            if (!rename($partial, $final)) {
                throw new \RuntimeException("cannot move backup into place: $final");
            }
        } finally {
            @unlink($options);
            @unlink($partial);
        }
        $this->prune();
        return $final;
    }

    /** Existing backups, newest first. @return list<string> */
    public function files(): array
    {
        $files = glob($this->dir . '/' . self::PREFIX . '*' . self::SUFFIX) ?: [];
        rsort($files, SORT_STRING); // the timestamp in the name sorts chronologically
        return $files;
    }

    /** Delete all but the newest $keep backups. Returns the paths removed. @return list<string> */
    public function prune(): array
    {
        $removed = [];
        foreach (array_slice($this->files(), $this->keep) as $old) {
            if (@unlink($old)) {
                $removed[] = $old;
            }
        }
        return $removed;
    }

    /** @param array{host:?string,port:?int,socket:?string,dbname:string} $conn */
    private function writeOptionFile(array $conn): string
    {
        $path = tempnam($this->dir, '.my');
        if ($path === false) {
            throw new \RuntimeException("backup directory is not writable: {$this->dir}");
        }
        chmod($path, 0600);
        $lines = ['[client]', 'user=' . self::quote((string) ($this->db['user'] ?? '')), 'password=' . self::quote((string) ($this->db['password'] ?? ''))];
        if ($conn['socket'] !== null) {
            $lines[] = 'socket=' . self::quote($conn['socket']);
        } else {
            if ($conn['host'] !== null) {
                $lines[] = 'host=' . self::quote($conn['host']);
            }
            if ($conn['port'] !== null) {
                $lines[] = 'port=' . $conn['port'];
            }
        }
        // Oracle's mysqldump 8 asks a MariaDB server for column statistics it
        // does not have. "loose-" makes other clients ignore the option.
        $lines[] = '[mysqldump]';
        $lines[] = 'loose-column-statistics=0';
        file_put_contents($path, implode("\n", $lines) . "\n");
        return $path;
    }

    private static function quote(string $value): string
    {
        return '"' . addcslashes($value, "\\\"") . '"';
    }

    private function dump(string $optionFile, string $dbname, string $target): void
    {
        $cmd = [
            $this->mysqldump,
            '--defaults-extra-file=' . $optionFile,
            '--single-transaction', // a consistent snapshot without locking InnoDB tables
            '--quick',
            '--no-tablespaces',
            $dbname,
        ];
        $proc = @proc_open($cmd, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        if (!is_resource($proc)) {
            throw new \RuntimeException("cannot run {$this->mysqldump}; set backup.mysqldump in config.php to its full path");
        }
        $out = gzopen($target, 'wb6');
        if ($out === false) {
            proc_terminate($proc);
            throw new \RuntimeException("cannot write $target");
        }
        chmod($target, 0600);
        stream_set_blocking($pipes[2], false);
        $bytes = 0;
        $stderr = '';
        while (!feof($pipes[1])) {
            $chunk = fread($pipes[1], 1 << 16);
            if ($chunk !== false && $chunk !== '') {
                gzwrite($out, $chunk);
                $bytes += strlen($chunk);
            }
            $stderr .= (string) stream_get_contents($pipes[2]);
        }
        stream_set_blocking($pipes[2], true);
        $stderr .= (string) stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        gzclose($out);
        $code = proc_close($proc);
        if ($code !== 0 || $bytes === 0) {
            // Drop the notice MariaDB's client prints about the option meant for Oracle's.
            $stderr = (string) preg_replace("/^Warning: .*loose-column-statistics.*\n?/m", '', $stderr);
            throw new \RuntimeException('mysqldump failed' . ($code !== 0 ? " (exit $code)" : ' (no output)') . ': ' . trim($stderr));
        }
    }
}
