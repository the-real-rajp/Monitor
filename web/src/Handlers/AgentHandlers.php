<?php
declare(strict_types=1);

namespace Monitor\Handlers;

use Monitor\App;
use Monitor\Auth\AgentKeys;
use Monitor\Clock;
use Monitor\Http\HttpError;
use Monitor\Http\Request;
use Monitor\Http\Response;

/** Admin management of proxies (the agents table). */
final class AgentHandlers
{
    /** Seconds without a heartbeat before a proxy is shown offline. */
    public const OFFLINE_AFTER_S = 120;

    public function __construct(private readonly App $app)
    {
    }

    public function list(Request $req): Response
    {
        $now = Clock::now();
        $rows = $this->app->db->all(
            'SELECT a.*, (SELECT COUNT(*) FROM devices d WHERE d.agent_id = a.id AND d.enabled = 1) AS device_count
               FROM agents a ORDER BY a.revoked_at IS NOT NULL, a.name',
        );
        return Response::json(['agents' => array_map(fn ($a) => self::toApi($a, $now), $rows)]);
    }

    /** Creates a proxy and returns its key once. */
    public function create(Request $req): Response
    {
        $in = $req->json(['name']);
        $name = self::validName($in['name'] ?? null);
        $k = AgentKeys::generate();
        $this->app->db->exec(
            'INSERT INTO agents (name, key_prefix, key_hash) VALUES (?, ?, ?)',
            [$name, $k['prefix'], $k['hash']],
        );
        $id = $this->app->db->lastId();
        $out = self::toApi($this->load($id), Clock::now());
        $out['key'] = $k['key'];
        $out['install_command'] = $this->installCommand($k['key']);
        return Response::json($out, 201);
    }

    public function update(Request $req): Response
    {
        $id = $req->intParam('id');
        $this->load($id);
        $in = $req->json(['name']);
        $name = self::validName($in['name'] ?? null);
        $this->app->db->exec('UPDATE agents SET name = ? WHERE id = ?', [$name, $id]);
        return Response::json(self::toApi($this->load($id), Clock::now()));
    }

    /** Revokes the key and detaches devices. History is kept. */
    public function delete(Request $req): Response
    {
        $id = $req->intParam('id');
        $this->load($id);
        $this->app->db->transaction(function ($db) use ($id) {
            $db->exec('UPDATE devices SET agent_id = NULL, enabled = 0 WHERE agent_id = ?', [$id]);
            $db->exec('UPDATE agents SET revoked_at = UTC_TIMESTAMP() WHERE id = ?', [$id]);
        });
        return Response::noContent();
    }

    /** Issues a new key; the old one stops working at once. */
    public function rotate(Request $req): Response
    {
        $id = $req->intParam('id');
        $a = $this->load($id);
        if ($a['revoked_at'] !== null) {
            throw HttpError::conflict('this proxy was revoked');
        }
        $k = AgentKeys::generate();
        $this->app->db->exec('UPDATE agents SET key_prefix = ?, key_hash = ? WHERE id = ?', [$k['prefix'], $k['hash'], $id]);
        $out = self::toApi($this->load($id), Clock::now());
        $out['key'] = $k['key'];
        $out['install_command'] = $this->installCommand($k['key']);
        return Response::json($out);
    }

    private function installCommand(string $key): string
    {
        $url = $this->app->baseUrl();
        return "curl -fsSL $url/install.sh | sudo sh -s -- --url $url --key $key";
    }

    private static function validName(mixed $name): string
    {
        $name = trim((string) $name);
        if ($name === '' || mb_strlen($name) > 100) {
            throw HttpError::badRequest('name is required and at most 100 characters');
        }
        return $name;
    }

    /** @return array<string,mixed> */
    private function load(int $id): array
    {
        return $this->app->db->one(
            'SELECT a.*, (SELECT COUNT(*) FROM devices d WHERE d.agent_id = a.id AND d.enabled = 1) AS device_count FROM agents a WHERE a.id = ?',
            [$id],
        ) ?? throw HttpError::notFound('proxy not found');
    }

    /** @param array<string,mixed> $a */
    public static function toApi(array $a, int $now): array
    {
        $seen = $a['last_seen_at'] === null ? null : Clock::fromDb((string) $a['last_seen_at']);
        return [
            'id'           => (int) $a['id'],
            'name'         => $a['name'],
            'key_prefix'   => $a['key_prefix'],
            'version'      => $a['version'],
            'last_seen_at' => Clock::iso($a['last_seen_at']),
            'last_ip'      => $a['last_ip'],
            'queue_depth'  => (int) $a['queue_depth'],
            'device_count' => (int) ($a['device_count'] ?? 0),
            'created_at'   => Clock::iso($a['created_at']),
            'revoked_at'   => Clock::iso($a['revoked_at']),
            'online'       => $a['revoked_at'] === null && $seen !== null && $now - $seen <= self::OFFLINE_AFTER_S,
        ];
    }
}
