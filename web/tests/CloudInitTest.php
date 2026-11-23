<?php
declare(strict_types=1);

namespace Monitor\Tests;

use Monitor\Agent\CloudInit;

/** Pure rendering checks; no database needed. */
final class CloudInitTest extends \PHPUnit\Framework\TestCase
{
    private const KEY = 'mon_0123456789ab_' . 'cdefcdefcdefcdefcdefcdefcdefcdefcdefcdefcdefcdefcdefcdefcdefcdef';

    public function testRendersUrlKeyAndHostname(): void
    {
        $out = CloudInit::render('https://monitor.example.com', self::KEY, 'Main Office');
        $this->assertStringStartsWith("#cloud-config\n", $out);
        $this->assertStringContainsString("hostname: monitor-main-office\n", $out);
        $this->assertStringContainsString("URL='https://monitor.example.com'\n", $out);
        $this->assertStringContainsString("KEY='" . self::KEY . "'\n", $out);
        $this->assertStringNotContainsString('__', $out);
    }

    public function testHostnameIsDnsSafe(): void
    {
        $this->assertSame('monitor-proxy', CloudInit::hostname('!!!'));
        $this->assertSame('monitor-office', CloudInit::hostname('Office proxy'));
        $this->assertSame('monitor-hq-evil-yaml', CloudInit::hostname("HQ\n- evil: yaml"));
        $long = CloudInit::hostname(str_repeat('a b ', 40));
        $this->assertLessThanOrEqual(63, strlen($long));
        $this->assertMatchesRegularExpression('/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/', $long);
    }

    public function testRejectsValuesThatCouldBreakQuoting(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        CloudInit::render("https://x.example'; rm -rf /; '", self::KEY, 'x');
    }

    public function testRejectsMalformedKey(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        CloudInit::render('https://x.example', "mon_ab_cd'\n", 'x');
    }
}
