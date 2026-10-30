#!/usr/bin/env php
<?php
declare(strict_types=1);
// Manage users from the shell (the first admin has to be created this way).
//   php bin/user.php create --email you@example.com --name "You" [--role admin|viewer]
//   php bin/user.php list
//   php bin/user.php password --email you@example.com
// The password is prompted for, or read from stdin when --password-stdin is given.
require __DIR__ . '/../vendor/autoload.php';

use Monitor\App;
use Monitor\Users;

$args = array_slice($argv, 1);
$cmd = array_shift($args) ?? 'help';
$opts = [];
for ($i = 0; $i < count($args); $i++) {
    if (str_starts_with($args[$i], '--')) {
        $k = substr($args[$i], 2);
        $v = ($i + 1 < count($args) && !str_starts_with($args[$i + 1], '--')) ? $args[++$i] : true;
        $opts[$k] = $v;
    }
}

$app = App::fromConfigFile(getenv('MONITOR_CONFIG') ?: __DIR__ . '/../config.php');
$users = new Users($app->db);

$readPassword = function () use ($opts): string {
    if ($opts['password-stdin'] ?? false) {
        return rtrim((string) fgets(STDIN), "\r\n");
    }
    // Prompt on the controlling terminal. Some shared hosts (cPanel jailshell)
    // report STDIN as not a tty, so do not rely on stream_isatty(); open
    // /dev/tty directly and fall back to STDIN only when that is unavailable.
    $tty = @fopen('/dev/tty', 'r+');
    $in = $tty ?: STDIN;
    $out = $tty ?: STDERR;
    $prompt = function (string $label) use ($in, $out): string {
        fwrite($out, $label);
        $hadEcho = @shell_exec('stty -g 2>/dev/null');
        if ($hadEcho) {
            @shell_exec('stty -echo 2>/dev/null');
        }
        $line = fgets($in);
        if ($hadEcho) {
            @shell_exec('stty ' . trim((string) $hadEcho) . ' 2>/dev/null');
        }
        fwrite($out, "\n");
        if ($line === false) {
            fwrite(STDERR, "no password given (use --password-stdin to pipe one in)\n");
            exit(1);
        }
        return rtrim($line, "\r\n");
    };
    $a = $prompt('Password: ');
    $b = $prompt('Confirm: ');
    if ($tty) {
        fclose($tty);
    }
    if ($a !== $b) {
        fwrite(STDERR, "passwords do not match\n");
        exit(1);
    }
    return $a;
};

try {
    switch ($cmd) {
        case 'create':
            $email = (string) ($opts['email'] ?? '');
            $name = (string) ($opts['name'] ?? '');
            $role = (string) ($opts['role'] ?? 'admin');
            if ($email === '' || $name === '') {
                throw new InvalidArgumentException('--email and --name are required');
            }
            $id = $users->create($email, $name, $role, $readPassword());
            echo "created user #$id $email ($role)\n";
            break;
        case 'password':
            $email = (string) ($opts['email'] ?? '');
            $u = $users->byEmail($email) ?? throw new InvalidArgumentException("no user $email");
            $users->setPassword((int) $u['id'], $readPassword());
            echo "password updated for $email; all sessions revoked\n";
            break;
        case 'list':
            printf("%-5s %-32s %-24s %-7s %s\n", 'ID', 'EMAIL', 'NAME', 'ROLE', 'STATUS');
            foreach ($users->all() as $u) {
                printf("%-5d %-32s %-24s %-7s %s\n", $u['id'], $u['email'], $u['name'], $u['role'], $u['disabled_at'] ? 'disabled' : 'active');
            }
            break;
        default:
            echo "usage: user.php create|password|list [--email E] [--name N] [--role admin|viewer] [--password-stdin]\n";
            exit($cmd === 'help' ? 0 : 1);
    }
} catch (Throwable $e) {
    fwrite(STDERR, 'error: ' . $e->getMessage() . "\n");
    exit(1);
}
