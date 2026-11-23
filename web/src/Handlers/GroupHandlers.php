<?php
declare(strict_types=1);

namespace Monitor\Handlers;

use Monitor\App;
use Monitor\Http\HttpError;
use Monitor\Http\Request;
use Monitor\Http\Response;

final class GroupHandlers
{
    public function __construct(private readonly App $app)
    {
    }

    public function list(Request $req): Response
    {
        $rows = $this->app->db->all(
            'SELECT g.*, (SELECT COUNT(*) FROM devices d WHERE d.group_id = g.id) AS device_count
               FROM device_groups g ORDER BY g.sort_order, g.name',
        );
        return Response::json(['groups' => array_map([self::class, 'toApi'], $rows)]);
    }

    public function create(Request $req): Response
    {
        $in = $req->json(['name', 'sort_order']);
        $name = self::validName($in['name'] ?? null);
        $order = $in['sort_order'] ?? (int) $this->app->db->value('SELECT COALESCE(MAX(sort_order), 0) + 1 FROM device_groups');
        if (!is_int($order)) {
            throw HttpError::badRequest('sort_order must be an integer');
        }
        $this->app->db->exec('INSERT INTO device_groups (name, sort_order) VALUES (?, ?)', [$name, $order]);
        $id = $this->app->db->lastId();
        return Response::json(self::toApi($this->load($id)), 201);
    }

    public function update(Request $req): Response
    {
        $id = $req->intParam('id');
        $cur = $this->load($id);
        $in = $req->json(['name', 'sort_order']);
        $name = array_key_exists('name', $in) ? self::validName($in['name']) : $cur['name'];
        $order = $in['sort_order'] ?? (int) $cur['sort_order'];
        if (!is_int($order)) {
            throw HttpError::badRequest('sort_order must be an integer');
        }
        $this->app->db->exec('UPDATE device_groups SET name = ?, sort_order = ? WHERE id = ?', [$name, $order, $id]);
        return Response::json(self::toApi($this->load($id)));
    }

    /** Deleting a group leaves its devices ungrouped (FK ON DELETE SET NULL). */
    public function delete(Request $req): Response
    {
        $id = $req->intParam('id');
        $this->load($id);
        $this->app->db->exec('DELETE FROM device_groups WHERE id = ?', [$id]);
        return Response::noContent();
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
            'SELECT g.*, (SELECT COUNT(*) FROM devices d WHERE d.group_id = g.id) AS device_count FROM device_groups g WHERE g.id = ?',
            [$id],
        ) ?? throw HttpError::notFound('group not found');
    }

    /** @param array<string,mixed> $g */
    public static function toApi(array $g): array
    {
        return ['id' => (int) $g['id'], 'name' => $g['name'], 'sort_order' => (int) $g['sort_order'], 'device_count' => (int) ($g['device_count'] ?? 0)];
    }
}
