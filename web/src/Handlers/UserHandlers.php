<?php
declare(strict_types=1);

namespace Monitor\Handlers;

use Monitor\App;
use Monitor\Db;
use Monitor\Http\HttpError;
use Monitor\Http\Request;
use Monitor\Http\Response;
use Monitor\Users;

/**
 * Admin management of dashboard logins. Two rules keep an admin from locking
 * everyone out: you cannot demote, disable or delete your own account, and
 * the last admin who can log in cannot be demoted, disabled or deleted.
 */
final class UserHandlers
{
    private readonly Users $users;

    public function __construct(private readonly App $app)
    {
        $this->users = new Users($app->db);
    }

    public function list(Request $req): Response
    {
        return Response::json(['users' => array_map(Users::toApi(...), $this->users->all())]);
    }

    public function create(Request $req): Response
    {
        $in = $req->json(['email', 'name', 'role', 'password']);
        $id = $this->users->create(
            (string) ($in['email'] ?? ''),
            (string) ($in['name'] ?? ''),
            (string) ($in['role'] ?? 'viewer'),
            (string) ($in['password'] ?? ''),
        );
        return Response::json(Users::toApi($this->load($id)), 201);
    }

    public function update(Request $req): Response
    {
        $id = $req->intParam('id');
        $in = $req->json(['email', 'name', 'role', 'disabled']);
        $changes = [];
        if (array_key_exists('email', $in)) {
            $changes['email'] = Users::normalizeEmail((string) $in['email']);
        }
        if (array_key_exists('name', $in)) {
            $changes['name'] = Users::validName((string) $in['name']);
        }
        if (array_key_exists('role', $in)) {
            $changes['role'] = Users::validRole((string) $in['role']);
        }
        if (array_key_exists('disabled', $in)) {
            if (!is_bool($in['disabled'])) {
                throw HttpError::badRequest('disabled must be true or false');
            }
            $changes['disabled'] = $in['disabled'];
        }
        $actorId = self::actorId($req);
        $this->app->db->transaction(function (Db $db) use ($id, $changes, $actorId) {
            $user = $this->load($id);
            $demotes = ($changes['role'] ?? $user['role']) !== 'admin' && $user['role'] === 'admin';
            $disables = ($changes['disabled'] ?? false) && $user['disabled_at'] === null;
            if ($demotes || $disables) {
                if ($id === $actorId) {
                    throw HttpError::conflict('you cannot remove your own admin access; ask another admin');
                }
                $this->guardLastAdmin($user);
            }
            $this->users->update($id, $changes);
        });
        return Response::json(Users::toApi($this->load($id)));
    }

    /** Sets a new password for someone else and signs them out everywhere. */
    public function setPassword(Request $req): Response
    {
        $id = $req->intParam('id');
        $in = $req->json(['password']);
        $this->load($id);
        if ($id === self::actorId($req)) {
            throw HttpError::conflict('change your own password on the Account page');
        }
        $this->users->setPassword($id, (string) ($in['password'] ?? ''));
        return Response::noContent();
    }

    public function delete(Request $req): Response
    {
        $id = $req->intParam('id');
        $actorId = self::actorId($req);
        $this->app->db->transaction(function (Db $db) use ($id, $actorId) {
            $user = $this->load($id);
            if ($id === $actorId) {
                throw HttpError::conflict('you cannot delete your own account; ask another admin');
            }
            $this->guardLastAdmin($user);
            $this->users->delete($id);
        });
        return Response::noContent();
    }

    /** @param array<string,mixed> $user */
    private function guardLastAdmin(array $user): void
    {
        $isActiveAdmin = $user['role'] === 'admin' && $user['disabled_at'] === null;
        if ($isActiveAdmin && $this->users->otherActiveAdmins((int) $user['id']) === 0) {
            throw HttpError::conflict('this is the only admin who can log in; make someone else an admin first');
        }
    }

    /** @return array<string,mixed> */
    private function load(int $id): array
    {
        return $this->users->byId($id) ?? throw HttpError::notFound('user not found');
    }

    private static function actorId(Request $req): int
    {
        return (int) $req->principal->user['id'];
    }
}
