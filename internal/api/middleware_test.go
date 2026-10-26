package api

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/the-real-rajp/monitor/internal/config"
	"github.com/the-real-rajp/monitor/internal/metrics"
)

func testServer() *Server {
	return &Server{
		Cfg:     config.Server{PublicURL: "https://monitor.example.com"},
		Log:     slog.Default(),
		Metrics: metrics.New(),
		loginRL: newRateLimiter(3, time.Minute),
	}
}

func TestCSRF(t *testing.T) {
	s := testServer()
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	h := s.csrf(ok)

	cases := []struct {
		name   string
		method string
		cookie bool
		hdr    map[string]string
		want   int
	}{
		{"get is always fine", "GET", true, map[string]string{"Origin": "https://evil.example"}, 204},
		{"no cookie means nothing to forge", "POST", false, map[string]string{"Origin": "https://evil.example"}, 204},
		{"same origin", "POST", true, map[string]string{"Origin": "https://monitor.example.com"}, 204},
		{"cross origin", "POST", true, map[string]string{"Origin": "https://evil.example"}, 403},
		{"referer fallback cross", "POST", true, map[string]string{"Referer": "https://evil.example/page"}, 403},
		{"referer fallback same", "POST", true, map[string]string{"Referer": "https://monitor.example.com/settings"}, 204},
		{"no origin, fetch metadata cross-site", "POST", true, map[string]string{"Sec-Fetch-Site": "cross-site"}, 403},
		{"no origin, fetch metadata same-origin", "POST", true, map[string]string{"Sec-Fetch-Site": "same-origin"}, 204},
		{"no origin, no hints (non-browser)", "POST", true, nil, 204},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := httptest.NewRequest(c.method, "/api/v1/users", nil)
			if c.cookie {
				r.AddCookie(&http.Cookie{Name: sessionCookie, Value: "x"})
			}
			for k, v := range c.hdr {
				r.Header.Set(k, v)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != c.want {
				t.Errorf("got %d, want %d", w.Code, c.want)
			}
		})
	}
}

func TestRateLimiter(t *testing.T) {
	rl := newRateLimiter(3, time.Hour)
	for i := 0; i < 3; i++ {
		if !rl.allow("a") {
			t.Fatalf("hit %d denied", i+1)
		}
	}
	if rl.allow("a") {
		t.Error("4th hit allowed")
	}
	if !rl.allow("b") {
		t.Error("separate key limited")
	}
}

func TestRequireAuth(t *testing.T) {
	s := testServer()
	okh := func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }
	for _, c := range []struct {
		level authLevel
		want  int
	}{{authNone, 204}, {authAny, 401}, {authSession, 401}, {authAdmin, 401}} {
		w := httptest.NewRecorder()
		s.requireAuth("/", c.level, okh).ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
		if w.Code != c.want {
			t.Errorf("level %d unauthenticated: got %d want %d", c.level, w.Code, c.want)
		}
	}
}

func TestSecurityHeadersAndAPI404(t *testing.T) {
	s := testServer()
	s.PG = nil
	h := s.Handler()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/does-not-exist", nil))
	if w.Code != 404 {
		t.Errorf("unknown api path: %d", w.Code)
	}
	if w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Cache-Control") != "no-store" {
		t.Errorf("security headers missing: %v", w.Header())
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("api 404 should be JSON, got %q", ct)
	}
}
