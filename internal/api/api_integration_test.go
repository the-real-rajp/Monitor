//go:build integration

package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/the-real-rajp/monitor/internal/auth"
	"github.com/the-real-rajp/monitor/internal/config"
	"github.com/the-real-rajp/monitor/internal/metrics"
	"github.com/the-real-rajp/monitor/internal/store/pg/sqlc"
	"github.com/the-real-rajp/monitor/internal/testutil"
)

const adminPassword = "admin-password-123"

type env struct {
	t   *testing.T
	srv *httptest.Server
	s   *Server
}

func newEnv(t *testing.T) *env {
	t.Helper()
	pgdb := testutil.PG(t)
	chdb := testutil.CH(t)
	ctx := context.Background()
	org, err := pgdb.Q.CreateOrg(ctx, sqlc.CreateOrgParams{Name: "Acme", Slug: "acme"})
	if err != nil {
		t.Fatal(err)
	}
	hash, _ := auth.HashPassword(adminPassword)
	if _, err := pgdb.Q.CreateUser(ctx, sqlc.CreateUserParams{
		OrgID: org.ID, Email: "admin@acme.test", Name: "Admin", Role: sqlc.UserRoleAdmin, PasswordHash: hash,
	}); err != nil {
		t.Fatal(err)
	}
	cfg := config.Server{PublicURL: "http://monitor.test", SessionTTL: time.Hour}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	s := New(cfg, log, pgdb, chdb, metrics.New(), nil)
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return &env{t: t, srv: srv, s: s}
}

type client struct {
	e        *env
	cookie   *http.Cookie
	bearer   string
	lastBody string
}

func (e *env) client() *client { return &client{e: e} }

func (c *client) do(method, path string, body any) (*http.Response, map[string]any) {
	c.e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, c.e.srv.URL+path, rd)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://monitor.test")
	if c.cookie != nil {
		req.AddCookie(c.cookie)
	}
	if c.bearer != "" {
		req.Header.Set("Authorization", "Bearer "+c.bearer)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.e.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	raw, _ := io.ReadAll(resp.Body)
	c.lastBody = string(raw)
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out)
	}
	for _, ck := range resp.Cookies() {
		if ck.Name == sessionCookie {
			if ck.MaxAge < 0 {
				c.cookie = nil
			} else {
				c.cookie = ck
			}
		}
	}
	return resp, out
}

func (c *client) login(email, password string) *http.Response {
	resp, _ := c.do("POST", "/api/v1/auth/login", map[string]string{"email": email, "password": password})
	return resp
}

func expect(t *testing.T, resp *http.Response, want int, what string) {
	t.Helper()
	if resp.StatusCode != want {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("%s: got %d, want %d (%s)", what, resp.StatusCode, want, strings.TrimSpace(string(body)))
	}
}

func TestLoginLogoutMe(t *testing.T) {
	e := newEnv(t)
	c := e.client()

	resp, _ := c.do("GET", "/api/v1/auth/me", nil)
	expect(t, resp, 401, "me before login")

	expect(t, c.login("admin@acme.test", "wrong-password-xx"), 401, "bad password")
	expect(t, c.login("nobody@acme.test", adminPassword), 401, "unknown user")
	if c.cookie != nil {
		t.Fatal("cookie set on failed login")
	}

	expect(t, c.login("ADMIN@acme.test", adminPassword), 200, "login (case-insensitive email)")
	if c.cookie == nil || !c.cookie.HttpOnly {
		t.Fatal("session cookie missing or not HttpOnly")
	}

	resp, body := c.do("GET", "/api/v1/auth/me", nil)
	expect(t, resp, 200, "me")
	u := body["user"].(map[string]any)
	if u["email"] != "admin@acme.test" || u["role"] != "admin" || body["org"].(map[string]any)["slug"] != "acme" {
		t.Errorf("unexpected me: %v", body)
	}

	resp, _ = c.do("POST", "/api/v1/auth/logout", nil)
	expect(t, resp, 204, "logout")
	if c.cookie != nil {
		t.Fatal("cookie not cleared on logout")
	}
}

func TestLoginRateLimit(t *testing.T) {
	e := newEnv(t)
	c := e.client()
	var last int
	for i := 0; i < 12; i++ {
		last = c.login("admin@acme.test", "wrong-password-xx").StatusCode
	}
	if last != 429 {
		t.Errorf("after 12 bad logins got %d, want 429", last)
	}
}

func TestCSRFBlocksCrossOriginWithCookie(t *testing.T) {
	e := newEnv(t)
	c := e.client()
	expect(t, c.login("admin@acme.test", adminPassword), 200, "login")
	req, _ := http.NewRequest("POST", e.srv.URL+"/api/v1/api-keys", strings.NewReader(`{"name":"x","scopes":["read"]}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://evil.test")
	req.AddCookie(c.cookie)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	expect(t, resp, 403, "cross-origin POST")
}

func TestUserLifecycleAndRoles(t *testing.T) {
	e := newEnv(t)
	admin := e.client()
	expect(t, admin.login("admin@acme.test", adminPassword), 200, "admin login")

	// validation
	resp, _ := admin.do("POST", "/api/v1/users", map[string]any{"email": "bad", "name": "x", "role": "member", "password": "long-enough-password"})
	expect(t, resp, 400, "bad email")
	resp, _ = admin.do("POST", "/api/v1/users", map[string]any{"email": "m@acme.test", "name": "x", "role": "member", "password": "short"})
	expect(t, resp, 400, "short password")
	resp, _ = admin.do("POST", "/api/v1/users", map[string]any{"email": "m@acme.test", "name": "x", "role": "king", "password": "long-enough-password"})
	expect(t, resp, 400, "bad role")
	resp, _ = admin.do("POST", "/api/v1/users", map[string]any{"email": "m@acme.test", "name": "x", "role": "member", "password": "long-enough-password", "extra": 1})
	expect(t, resp, 400, "unknown field")

	// create
	resp, body := admin.do("POST", "/api/v1/users", map[string]any{"email": "Member@acme.test", "name": "Mem", "role": "member", "password": "member-password-1"})
	expect(t, resp, 201, "create member")
	memberID := body["id"].(string)
	if body["email"] != "member@acme.test" {
		t.Errorf("email not normalised: %v", body["email"])
	}
	resp, _ = admin.do("POST", "/api/v1/users", map[string]any{"email": "member@acme.test", "name": "Dup", "role": "member", "password": "member-password-1"})
	expect(t, resp, 409, "duplicate email")

	// list
	resp, body = admin.do("GET", "/api/v1/users", nil)
	expect(t, resp, 200, "list")
	if n := len(body["users"].([]any)); n != 2 {
		t.Errorf("list has %d users, want 2", n)
	}

	// member cannot manage users
	member := e.client()
	expect(t, member.login("member@acme.test", "member-password-1"), 200, "member login")
	resp, _ = member.do("GET", "/api/v1/users", nil)
	expect(t, resp, 403, "member list users")
	resp, _ = member.do("GET", "/api/v1/auth/me", nil)
	expect(t, resp, 200, "member me")

	// last-admin protection
	adminID := ""
	for _, u := range body["users"].([]any) {
		if u.(map[string]any)["role"] == "admin" {
			adminID = u.(map[string]any)["id"].(string)
		}
	}
	resp, _ = admin.do("PATCH", "/api/v1/users/"+adminID, map[string]any{"role": "member"})
	expect(t, resp, 409, "demote last admin")
	resp, _ = admin.do("PATCH", "/api/v1/users/"+adminID, map[string]any{"disabled": true})
	expect(t, resp, 409, "disable last admin")
	resp, _ = admin.do("DELETE", "/api/v1/users/"+adminID, nil)
	expect(t, resp, 409, "delete self")

	// promote member, then demoting original admin is fine
	resp, body = admin.do("PATCH", "/api/v1/users/"+memberID, map[string]any{"role": "admin", "name": "Mem Two"})
	expect(t, resp, 200, "promote")
	if body["role"] != "admin" || body["name"] != "Mem Two" {
		t.Errorf("patch result: %v", body)
	}
	resp, _ = admin.do("PATCH", "/api/v1/users/"+memberID, map[string]any{"role": "member"})
	expect(t, resp, 200, "demote second admin while another remains")

	// disabling revokes sessions
	resp, _ = admin.do("PATCH", "/api/v1/users/"+memberID, map[string]any{"disabled": true})
	expect(t, resp, 200, "disable member")
	resp, _ = member.do("GET", "/api/v1/auth/me", nil)
	expect(t, resp, 401, "disabled user's session is dead")
	expect(t, member.login("member@acme.test", "member-password-1"), 401, "disabled user cannot log in")

	// password reset by admin revokes sessions and the new password works
	resp, _ = admin.do("PATCH", "/api/v1/users/"+memberID, map[string]any{"disabled": false, "password": "new-member-password"})
	expect(t, resp, 200, "re-enable with new password")
	expect(t, member.login("member@acme.test", "member-password-1"), 401, "old password")
	expect(t, member.login("member@acme.test", "new-member-password"), 200, "new password")

	// delete
	resp, _ = admin.do("DELETE", "/api/v1/users/"+memberID, nil)
	expect(t, resp, 204, "delete member")
	resp, _ = admin.do("GET", "/api/v1/users/"+memberID, nil)
	expect(t, resp, 404, "deleted user gone")
	resp, _ = admin.do("GET", "/api/v1/users/not-a-uuid", nil)
	expect(t, resp, 404, "bad uuid is a 404")
}

func TestChangeOwnPassword(t *testing.T) {
	e := newEnv(t)
	c := e.client()
	expect(t, c.login("admin@acme.test", adminPassword), 200, "login")
	resp, _ := c.do("POST", "/api/v1/auth/password", map[string]string{"current_password": "nope-nope-nope", "new_password": "a-brand-new-password"})
	expect(t, resp, 401, "wrong current password")
	resp, _ = c.do("POST", "/api/v1/auth/password", map[string]string{"current_password": adminPassword, "new_password": "short"})
	expect(t, resp, 400, "weak new password")
	resp, _ = c.do("POST", "/api/v1/auth/password", map[string]string{"current_password": adminPassword, "new_password": "a-brand-new-password"})
	expect(t, resp, 204, "change password")
	resp, _ = c.do("GET", "/api/v1/auth/me", nil)
	expect(t, resp, 200, "still logged in on re-issued session")
	expect(t, e.client().login("admin@acme.test", "a-brand-new-password"), 200, "new password works")
}

func TestAPIKeys(t *testing.T) {
	e := newEnv(t)
	admin := e.client()
	expect(t, admin.login("admin@acme.test", adminPassword), 200, "login")

	resp, _ := admin.do("POST", "/api/v1/api-keys", map[string]any{"name": "agent", "scopes": []string{"launch"}})
	expect(t, resp, 400, "bad scope")
	resp, _ = admin.do("POST", "/api/v1/api-keys", map[string]any{"name": "", "scopes": []string{"ingest"}})
	expect(t, resp, 400, "empty name")

	resp, body := admin.do("POST", "/api/v1/api-keys", map[string]any{"name": "agent", "scopes": []string{"ingest", "ingest", "read"}})
	expect(t, resp, 201, "create key")
	key := body["key"].(string)
	id := body["id"].(string)
	if !strings.HasPrefix(key, "mon_") || len(body["scopes"].([]any)) != 2 {
		t.Errorf("unexpected key response: %v", body)
	}

	// list never includes the secret
	resp, body = admin.do("GET", "/api/v1/api-keys", nil)
	expect(t, resp, 200, "list keys")
	if _, has := body["api_keys"].([]any)[0].(map[string]any)["key"]; has {
		t.Error("list leaks key secret")
	}

	// bearer auth
	machine := e.client()
	machine.bearer = key
	resp, body = machine.do("GET", "/api/v1/auth/me", nil)
	expect(t, resp, 200, "me with api key")
	if body["user"] != nil || body["api_key"].(map[string]any)["name"] != "agent" {
		t.Errorf("api key me: %v", body)
	}
	resp, _ = machine.do("GET", "/api/v1/users", nil)
	expect(t, resp, 401, "api key cannot use session-only endpoints")

	bad := e.client()
	flip := "0"
	if strings.HasSuffix(key, "0") {
		flip = "1"
	}
	bad.bearer = key[:len(key)-1] + flip
	resp, _ = bad.do("GET", "/api/v1/auth/me", nil)
	expect(t, resp, 401, "tampered key")
	bad.bearer = "garbage"
	resp, _ = bad.do("GET", "/api/v1/auth/me", nil)
	expect(t, resp, 401, "malformed key")

	// revoke
	resp, _ = admin.do("DELETE", "/api/v1/api-keys/"+id, nil)
	expect(t, resp, 204, "revoke")
	resp, _ = admin.do("DELETE", "/api/v1/api-keys/"+id, nil)
	expect(t, resp, 404, "revoke twice")
	resp, _ = machine.do("GET", "/api/v1/auth/me", nil)
	expect(t, resp, 401, "revoked key rejected")
}

func TestHealthAndVersion(t *testing.T) {
	e := newEnv(t)
	c := e.client()
	resp, body := c.do("GET", "/readyz", nil)
	expect(t, resp, 200, "readyz")
	if body["status"] != "ok" {
		t.Errorf("readyz body: %v", body)
	}
	resp, body = c.do("GET", "/api/v1/version", nil)
	expect(t, resp, 200, "version")
	if body["version"] != "dev" {
		t.Errorf("version: %v", body)
	}
	// request metrics were recorded
	found := false
	for _, s := range e.s.Metrics.Snapshot() {
		if s.Name == "monitor.http.requests" && s.Labels["route"] == "/readyz" {
			found = true
		}
	}
	if !found {
		t.Error("http request metric not recorded with route label")
	}
}
