package api

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/the-real-rajp/monitor/internal/auth"
	"github.com/the-real-rajp/monitor/internal/store/pg/sqlc"
)

// Principal is the authenticated caller, from a session cookie or an API key.
type Principal struct {
	OrgID  uuid.UUID
	User   *sqlc.User   // set for sessions
	APIKey *sqlc.ApiKey // set for API keys
}

// IsAdmin reports whether the principal is an admin user.
func (p *Principal) IsAdmin() bool {
	return p != nil && p.User != nil && p.User.Role == sqlc.UserRoleAdmin
}

type ctxKey int

const (
	principalKey ctxKey = iota
	sessionHashKey
	reqInfoKey
)

// reqInfo is filled in by the route wrapper so the outer observe middleware
// can label metrics with the matched pattern rather than the raw path.
type reqInfo struct{ route string }

// principalFrom returns the caller, or nil when unauthenticated.
func principalFrom(ctx context.Context) *Principal {
	p, _ := ctx.Value(principalKey).(*Principal)
	return p
}

const sessionCookie = "monitor_session"

// authenticate resolves the session cookie or bearer API key, if present,
// and stores the principal in the context. It never rejects; requireAuth
// does that per route.
func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		if c, err := r.Cookie(sessionCookie); err == nil && c.Value != "" {
			hash := auth.HashToken(c.Value)
			row, err := s.PG.Q.GetSessionUser(ctx, hash)
			switch {
			case err == nil:
				u := row.User
				ctx = context.WithValue(ctx, principalKey, &Principal{OrgID: u.OrgID, User: &u})
				ctx = context.WithValue(ctx, sessionHashKey, hash)
				// Sliding expiry: refresh at most once a minute to avoid write amplification.
				if time.Until(row.ExpiresAt) < s.Cfg.SessionTTL-time.Minute {
					go s.sessions.touch(hash, s.Cfg.SessionTTL)
				}
			case errors.Is(err, pgx.ErrNoRows):
				clearSessionCookie(w, s.Cfg.SecureCookies)
			default:
				s.Log.Error("session lookup failed", "err", err)
				writeError(w, http.StatusInternalServerError, "internal", "internal error")
				return
			}
		} else if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			key := strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
			prefix, hash, err := auth.ParseAPIKey(key)
			if err != nil {
				writeError(w, http.StatusUnauthorized, "unauthorized", "malformed api key")
				return
			}
			k, err := s.PG.Q.GetAPIKeyByPrefix(ctx, prefix)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				s.Log.Error("api key lookup failed", "err", err)
				writeError(w, http.StatusInternalServerError, "internal", "internal error")
				return
			}
			if err != nil || !hashEqual(k.KeyHash, hash) {
				writeError(w, http.StatusUnauthorized, "unauthorized", "invalid api key")
				return
			}
			ctx = context.WithValue(ctx, principalKey, &Principal{OrgID: k.OrgID, APIKey: &k})
			go s.touchAPIKey(k.ID)
		}
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func hashEqual(a, b []byte) bool {
	// Constant-time compare so a prefix collision cannot be probed by timing.
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := range a {
		v |= a[i] ^ b[i]
	}
	return v == 0
}

func (s *Server) touchAPIKey(id uuid.UUID) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.PG.Q.TouchAPIKey(ctx, id); err != nil {
		s.Log.Warn("touch api key", "err", err)
	}
}

// requireAuth enforces the route's auth level and records the matched route.
func (s *Server) requireAuth(pattern string, level authLevel, next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if info, ok := r.Context().Value(reqInfoKey).(*reqInfo); ok {
			info.route = pattern
		}
		p := principalFrom(r.Context())
		switch level {
		case authNone:
		case authAny:
			if p == nil {
				writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
				return
			}
		case authSession:
			if p == nil || p.User == nil {
				writeError(w, http.StatusUnauthorized, "unauthorized", "login required")
				return
			}
		case authAdmin:
			if p == nil || p.User == nil {
				writeError(w, http.StatusUnauthorized, "unauthorized", "login required")
				return
			}
			if !p.IsAdmin() {
				writeError(w, http.StatusForbidden, "forbidden", "admin role required")
				return
			}
		}
		next(w, r)
	})
}

// csrf rejects state-changing browser requests whose Origin (or Referer) is
// not our own public URL. API-key requests carry no cookie and are exempt,
// as are safe methods. SameSite=Lax on the cookie is the second layer.
func (s *Server) csrf(next http.Handler) http.Handler {
	pub, _ := url.Parse(s.Cfg.PublicURL)
	allowedHost := ""
	if pub != nil {
		allowedHost = pub.Host
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		if _, err := r.Cookie(sessionCookie); err != nil {
			next.ServeHTTP(w, r) // no cookie, nothing to forge
			return
		}
		src := r.Header.Get("Origin")
		if src == "" {
			src = r.Header.Get("Referer")
		}
		if src == "" {
			// Browsers always send Origin on cross-site POSTs; its absence
			// means a same-origin fetch or a non-browser client. Allow, but
			// require the Sec-Fetch-Site hint when the browser provides it.
			if sfs := r.Header.Get("Sec-Fetch-Site"); sfs != "" && sfs != "same-origin" && sfs != "none" {
				writeError(w, http.StatusForbidden, "forbidden", "cross-site request rejected")
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		u, err := url.Parse(src)
		if err != nil || !strings.EqualFold(u.Host, allowedHost) {
			writeError(w, http.StatusForbidden, "forbidden", "cross-site request rejected")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// observe logs each request and records request metrics.
func (s *Server) observe(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		info := &reqInfo{}
		r = r.WithContext(context.WithValue(r.Context(), reqInfoKey, info))
		next.ServeHTTP(rw, r)
		route := info.route
		if route == "" {
			route = unmatchedRoute(r)
		}
		labels := map[string]string{
			"method": r.Method,
			"route":  route,
			"status": strconv.Itoa(rw.status),
		}
		s.Metrics.CounterAdd("monitor.http.requests", labels, 1)
		s.Metrics.ObserveDuration("monitor.http.request_seconds", map[string]string{"route": route}, start)
		level := s.Log.Debug
		if rw.status >= 500 {
			level = s.Log.Error
		}
		level("http", "method", r.Method, "path", r.URL.Path, "status", rw.status,
			"duration_ms", time.Since(start).Milliseconds(), "ip", clientIP(r))
	})
}

func unmatchedRoute(r *http.Request) string {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		return "/api/unmatched"
	}
	return "/static"
}

type statusWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (w *statusWriter) WriteHeader(code int) {
	if !w.wrote {
		w.status = code
		w.wrote = true
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	w.wrote = true
	return w.ResponseWriter.Write(b)
}

func (s *Server) recoverPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				s.Log.Error("panic in handler", "panic", rec, "path", r.URL.Path, "stack", string(debug.Stack()))
				s.Metrics.CounterAdd("monitor.http.panics", nil, 1)
				writeError(w, http.StatusInternalServerError, "internal", "internal error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "same-origin")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// clientIP returns the remote address without the port. Proxies are a
// deployment concern; a trusted-proxy setting arrives with phase 4.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
