<?php
declare(strict_types=1);

namespace Monitor\Handlers;

use Monitor\App;
use Monitor\Auth\LoginThrottle;
use Monitor\Auth\Sessions;
use Monitor\Http\HttpError;
use Monitor\Http\Request;
use Monitor\Http\Response;
use Monitor\Users;

final class AuthHandlers
{
    private readonly Users $users;

    public function __construct(private readonly App $app)
    {
        $this->users = new Users($app->db);
    }

    public function login(Request $req): Response
    {
        $in = $req->json(['email', 'password']);
        $email = mb_strtolower(trim((string) ($in['email'] ?? '')));
        $password = (string) ($in['password'] ?? '');
        if ($email === '' || $password === '') {
            throw HttpError::badRequest('email and password are required');
        }
        $throttle = new LoginThrottle($this->app->db);
        if (!$throttle->allow('ip:' . $req->ip) || !$throttle->allow('email:' . $email)) {
            throw HttpError::rateLimited('too many login attempts, try again in a minute');
        }
        $user = $this->users->verify($email, $password);
        if ($user === null) {
            return Response::error(401, 'invalid_credentials', 'invalid email or password');
        }
        $token = $this->app->sessions->create((int) $user['id'], $req->header('user-agent') ?? '');
        return Response::json(['user' => Users::toApi($user)])
            ->withCookie(Sessions::COOKIE, $token, $this->app->sessions->cookieOptions($this->app->secureCookies()));
    }

    public function logout(Request $req): Response
    {
        $token = $req->principal?->sessionToken;
        if ($token !== null) {
            $this->app->sessions->delete($token);
        }
        return Response::noContent()
            ->withCookie(Sessions::COOKIE, '', $this->app->sessions->cookieOptions($this->app->secureCookies(), true));
    }

    public function me(Request $req): Response
    {
        return Response::json([
            'user'     => Users::toApi($req->principal->user),
            'timezone' => $this->app->timezone()->getName(),
        ]);
    }

    public function changePassword(Request $req): Response
    {
        $in = $req->json(['current_password', 'new_password']);
        $user = $req->principal->user;
        if (!password_verify((string) ($in['current_password'] ?? ''), (string) $user['password_hash'])) {
            return Response::error(401, 'invalid_credentials', 'current password is incorrect');
        }
        $this->users->setPassword((int) $user['id'], (string) ($in['new_password'] ?? ''));
        // setPassword revoked every session; re-issue one for this browser.
        $token = $this->app->sessions->create((int) $user['id'], $req->header('user-agent') ?? '');
        return Response::noContent()
            ->withCookie(Sessions::COOKIE, $token, $this->app->sessions->cookieOptions($this->app->secureCookies()));
    }
}
