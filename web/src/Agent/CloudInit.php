<?php
declare(strict_types=1);

namespace Monitor\Agent;

/**
 * Renders the cloud-init user data that turns a stock Ubuntu cloud image into
 * a proxy VM (Nutanix AHV, VMware vSphere). The VM runs the same install.sh a
 * Raspberry Pi would; this only removes the need to log in and type it.
 */
final class CloudInit
{
    public static function render(string $baseUrl, string $key, string $proxyName): string
    {
        // The URL and key land inside single quotes in a shell script, so
        // refuse anything that could end the quoting or the YAML block.
        if (!preg_match('#^https?://[A-Za-z0-9.\-_:/\[\]~%]+$#D', $baseUrl)) {
            throw new \InvalidArgumentException('base_url is not a plain http(s) URL');
        }
        if (!preg_match('/^mon_[0-9a-f]+_[0-9a-f]+$/D', $key)) {
            throw new \InvalidArgumentException('malformed agent key');
        }
        $path = __DIR__ . '/../../resources/cloud-init.yaml';
        $tpl = is_file($path) ? (string) file_get_contents($path) : throw new \RuntimeException('cloud-init template missing');
        return strtr($tpl, [
            '__BASE_URL__' => $baseUrl,
            '__KEY__'      => $key,
            '__HOSTNAME__' => self::hostname($proxyName),
        ]);
    }

    /** A DNS-safe host name such as "monitor-main-office". */
    public static function hostname(string $proxyName): string
    {
        $slug = trim((string) preg_replace('/[^a-z0-9]+/', '-', strtolower($proxyName)), '-');
        $slug = (string) preg_replace('/^(monitor|proxy)-|-proxy$/', '', $slug);
        $host = rtrim(substr('monitor-' . ($slug === '' ? 'proxy' : $slug), 0, 63), '-');
        return $host;
    }
}
