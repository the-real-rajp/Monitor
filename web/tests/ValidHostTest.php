<?php
declare(strict_types=1);

namespace Monitor\Tests;

use Monitor\Ping\WebPinger;

/** Which addresses a device may have. No database needed. */
final class ValidHostTest extends \PHPUnit\Framework\TestCase
{
    public function testAcceptsAddressesAndHostnames(): void
    {
        foreach (['10.0.0.2', '2001:db8::1', 'printer', 'nas-01.office.example.com', '3com-switch', 'host1'] as $host) {
            $this->assertTrue(WebPinger::validHost($host), $host);
        }
    }

    public function testRejectsMistypedAddresses(): void
    {
        foreach (['', '10.0.0.300', '10.0.0', '10.0.0.2.', '10..0.2', '-flag', 'has space', 'http://example.com', 'a_b.example.com'] as $host) {
            $this->assertFalse(WebPinger::validHost($host), $host);
        }
    }
}
