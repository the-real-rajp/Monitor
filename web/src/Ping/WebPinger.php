<?php
declare(strict_types=1);

namespace Monitor\Ping;

use Monitor\Clock;
use Monitor\Settings;

/**
 * Pings internet-facing devices from the web host, inside the cron budget.
 *
 * Method detection: shared hosts often block raw ICMP or disable exec().
 * On first run (or when configured 'auto'), we try the ping binary against
 * 127.0.0.1 and remember the outcome in settings. When ICMP is unavailable,
 * devices with a tcp_fallback_port are checked with a TCP connect and the
 * elapsed time is reported as the RTT; devices without a port get a timeout
 * result so the gap is visible rather than silent.
 */
final class WebPinger
{
    public const TIMEOUT_S = 3;

    public function __construct(private readonly Settings $settings, private readonly string $configured = 'auto')
    {
    }

    /** 'icmp' or 'tcp' */
    public function method(): string
    {
        if (in_array($this->configured, ['icmp', 'tcp'], true)) {
            return $this->configured;
        }
        $known = $this->settings->get('web_ping_method', 'unknown');
        if ($known === 'icmp' || $known === 'tcp') {
            return $known;
        }
        $detected = $this->icmpWorks() ? 'icmp' : 'tcp';
        $this->settings->set('web_ping_method', $detected);
        return $detected;
    }

    public function icmpWorks(): bool
    {
        if (!function_exists('proc_open') || !function_exists('exec')) {
            return false;
        }
        $disabled = array_map('trim', explode(',', (string) ini_get('disable_functions')));
        if (in_array('proc_open', $disabled, true) || in_array('exec', $disabled, true)) {
            return false;
        }
        $r = self::icmp('127.0.0.1');
        return $r !== null;
    }

    /**
     * Pings all devices in parallel and returns one result per device.
     *
     * @param list<array{id:int, host:string, tcp_fallback_port:int|null}> $devices
     * @return array<int, array{ts:string, rtt_ms:float|null, method:string}> keyed by device id
     */
    public function run(array $devices): array
    {
        $method = $this->method();
        $ts = Clock::dbNow();
        $out = [];
        if ($method === 'icmp') {
            $procs = [];
            foreach ($devices as $d) {
                $procs[$d['id']] = self::startPing($d['host']);
            }
            foreach ($procs as $id => $p) {
                $out[$id] = ['ts' => $ts, 'rtt_ms' => $p === null ? null : self::finishPing($p), 'method' => 'icmp'];
            }
            return $out;
        }
        foreach ($devices as $d) {
            $port = $d['tcp_fallback_port'];
            $rtt = $port === null ? null : self::tcp($d['host'], (int) $port);
            $out[$d['id']] = ['ts' => $ts, 'rtt_ms' => $rtt, 'method' => 'tcp'];
        }
        return $out;
    }

    /** One blocking ICMP ping. Returns RTT in ms or null on timeout/failure. */
    public static function icmp(string $host): ?float
    {
        $p = self::startPing($host);
        return $p === null ? null : self::finishPing($p);
    }

    /** @return array{0:resource,1:array<int,resource>}|null */
    private static function startPing(string $host): ?array
    {
        if (!self::validHost($host)) {
            return null;
        }
        $cmd = ['ping', '-n', '-c', '1', '-W', (string) self::TIMEOUT_S, $host];
        $pipes = [];
        $proc = @proc_open($cmd, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        if (!is_resource($proc)) {
            return null;
        }
        return [$proc, $pipes];
    }

    /** @param array{0:resource,1:array<int,resource>} $p */
    private static function finishPing(array $p): ?float
    {
        [$proc, $pipes] = $p;
        $stdout = stream_get_contents($pipes[1]) ?: '';
        fclose($pipes[1]);
        fclose($pipes[2]);
        $code = proc_close($proc);
        if ($code !== 0) {
            return null;
        }
        // "64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.3 ms"
        if (preg_match('/time[=<]([\d.]+)\s*ms/', $stdout, $m)) {
            return round((float) $m[1], 2);
        }
        return null;
    }

    /** TCP connect check. Returns connect time in ms or null. */
    public static function tcp(string $host, int $port): ?float
    {
        if (!self::validHost($host) || $port < 1 || $port > 65535) {
            return null;
        }
        $start = hrtime(true);
        $errno = 0;
        $errstr = '';
        $sock = @stream_socket_client("tcp://$host:$port", $errno, $errstr, self::TIMEOUT_S);
        if ($sock === false) {
            return null;
        }
        fclose($sock);
        return round((hrtime(true) - $start) / 1e6, 2);
    }

    /** Hostnames and IP literals only; nothing a shell or ping could misread as an option. */
    public static function validHost(string $host): bool
    {
        if ($host === '' || strlen($host) > 253 || $host[0] === '-') {
            return false;
        }
        if (filter_var($host, FILTER_VALIDATE_IP)) {
            return true;
        }
        return (bool) preg_match('/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i', $host);
    }
}
