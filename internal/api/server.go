// Package api is the HTTP layer: routing, middleware and handlers for the
// REST API described in api/openapi.yaml. Handlers are thin; they validate
// input, call the stores and shape the response.
package api

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/the-real-rajp/monitor/internal/config"
	"github.com/the-real-rajp/monitor/internal/metrics"
	"github.com/the-real-rajp/monitor/internal/store/ch"
	"github.com/the-real-rajp/monitor/internal/store/pg"
)

// Server holds the dependencies shared by all handlers.
type Server struct {
	Cfg      config.Server
	Log      *slog.Logger
	PG       *pg.DB
	CH       *ch.DB
	Metrics  *metrics.Registry
	UI       http.Handler // serves the web app; may be nil
	loginRL  *rateLimiter
	started  time.Time
	sessions sessionStore
}

// New wires a Server. UI may be nil when the web app is not embedded.
func New(cfg config.Server, log *slog.Logger, pgdb *pg.DB, chdb *ch.DB, reg *metrics.Registry, ui http.Handler) *Server {
	s := &Server{
		Cfg:     cfg,
		Log:     log,
		PG:      pgdb,
		CH:      chdb,
		Metrics: reg,
		UI:      ui,
		loginRL: newRateLimiter(10, time.Minute),
		started: time.Now(),
	}
	s.sessions = sessionStore{db: pgdb}
	return s
}

// Routes is the list of API routes. It is exported so the contract test can
// check every route against the OpenAPI document.
func (s *Server) Routes() []Route {
	return []Route{
		{"GET", "/healthz", s.handleHealthz, authNone},
		{"GET", "/readyz", s.handleReadyz, authNone},
		{"GET", "/api/v1/version", s.handleVersion, authNone},

		{"POST", "/api/v1/auth/login", s.handleLogin, authNone},
		{"POST", "/api/v1/auth/logout", s.handleLogout, authSession},
		{"GET", "/api/v1/auth/me", s.handleMe, authAny},
		{"POST", "/api/v1/auth/password", s.handleChangePassword, authSession},

		{"GET", "/api/v1/users", s.handleListUsers, authAdmin},
		{"POST", "/api/v1/users", s.handleCreateUser, authAdmin},
		{"GET", "/api/v1/users/{id}", s.handleGetUser, authAdmin},
		{"PATCH", "/api/v1/users/{id}", s.handleUpdateUser, authAdmin},
		{"DELETE", "/api/v1/users/{id}", s.handleDeleteUser, authAdmin},

		{"GET", "/api/v1/api-keys", s.handleListAPIKeys, authAdmin},
		{"POST", "/api/v1/api-keys", s.handleCreateAPIKey, authAdmin},
		{"DELETE", "/api/v1/api-keys/{id}", s.handleRevokeAPIKey, authAdmin},
	}
}

// Route is one HTTP route and the authentication it requires.
type Route struct {
	Method  string
	Pattern string
	Handler http.HandlerFunc
	Auth    authLevel
}

// authLevel describes who may call a route.
type authLevel int

const (
	authNone    authLevel = iota // public
	authAny                      // a session user or an API key
	authSession                  // a logged-in user of any role
	authAdmin                    // a logged-in admin
)

// Handler builds the full http.Handler with middleware applied.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	for _, r := range s.Routes() {
		h := s.requireAuth(r.Pattern, r.Auth, r.Handler)
		mux.Handle(r.Method+" "+r.Pattern, h)
	}
	// Anything under /api that did not match is a JSON 404, not the SPA.
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "no such endpoint")
	})
	if s.UI != nil {
		mux.Handle("/", s.UI)
	}

	var h http.Handler = mux
	h = s.csrf(h)
	h = s.authenticate(h)
	h = s.observe(h)
	h = s.recoverPanics(h)
	h = securityHeaders(h)
	return h
}
