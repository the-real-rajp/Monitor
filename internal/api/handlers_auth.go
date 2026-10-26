package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/the-real-rajp/monitor/internal/auth"
	"github.com/the-real-rajp/monitor/internal/store/pg/sqlc"
)

// Response shapes shared by the auth and user handlers. Field names are the
// contract in api/openapi.yaml.

type userResponse struct {
	ID        string    `json:"id"`
	OrgID     string    `json:"org_id"`
	Email     string    `json:"email"`
	Name      string    `json:"name"`
	Role      string    `json:"role"`
	Disabled  bool      `json:"disabled"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type orgResponse struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
}

type meResponse struct {
	User   *userResponse   `json:"user,omitempty"`
	APIKey *apiKeyResponse `json:"api_key,omitempty"`
	Org    orgResponse     `json:"org"`
}

func toUserResponse(u sqlc.User) userResponse {
	return userResponse{
		ID:        u.ID.String(),
		OrgID:     u.OrgID.String(),
		Email:     u.Email,
		Name:      u.Name,
		Role:      string(u.Role),
		Disabled:  u.DisabledAt != nil,
		CreatedAt: u.CreatedAt,
		UpdatedAt: u.UpdatedAt,
	}
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// handleLogin verifies credentials and sets the session cookie.
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := decodeJSON(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	req.Email = strings.TrimSpace(strings.ToLower(req.Email))
	if req.Email == "" || req.Password == "" {
		s.fail(w, r, errBadRequest("email and password are required"))
		return
	}
	// Limit by IP and by account so neither a single attacker nor a
	// distributed one can brute-force a password.
	if !s.loginRL.allow("ip:"+clientIP(r)) || !s.loginRL.allow("email:"+req.Email) {
		s.Metrics.CounterAdd("monitor.auth.login_rate_limited", nil, 1)
		writeError(w, http.StatusTooManyRequests, "rate_limited", "too many login attempts, try again later")
		return
	}

	u, err := s.PG.Q.GetUserByEmail(r.Context(), req.Email)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		s.fail(w, r, err)
		return
	}
	// Verify against a dummy hash on unknown users so the response time does
	// not reveal whether the email exists.
	hash := dummyHash
	if err == nil {
		hash = u.PasswordHash
	}
	ok := auth.VerifyPassword(hash, req.Password)
	if err != nil || !ok || u.DisabledAt != nil {
		s.Metrics.CounterAdd("monitor.auth.login_failures", nil, 1)
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "invalid email or password")
		return
	}

	token, err := s.sessions.create(r.Context(), u.ID, s.Cfg.SessionTTL, r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	setSessionCookie(w, token, s.Cfg.SessionTTL, s.Cfg.SecureCookies)
	s.Metrics.CounterAdd("monitor.auth.logins", nil, 1)
	org, err := s.PG.Q.GetOrg(r.Context(), u.OrgID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	ur := toUserResponse(u)
	writeJSON(w, http.StatusOK, meResponse{User: &ur, Org: orgResponse{ID: org.ID.String(), Name: org.Name, Slug: org.Slug}})
}

// dummyHash is a valid argon2id hash of a random string, computed once at
// startup, used to equalise timing for unknown emails.
var dummyHash = func() string {
	h, err := auth.HashPassword("not-a-real-password-just-for-timing")
	if err != nil {
		panic(err)
	}
	return h
}()

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if hash, ok := r.Context().Value(sessionHashKey).([]byte); ok {
		if err := s.sessions.delete(r.Context(), hash); err != nil {
			s.fail(w, r, err)
			return
		}
	}
	clearSessionCookie(w, s.Cfg.SecureCookies)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	p := principalFrom(r.Context())
	org, err := s.PG.Q.GetOrg(r.Context(), p.OrgID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	resp := meResponse{Org: orgResponse{ID: org.ID.String(), Name: org.Name, Slug: org.Slug}}
	if p.User != nil {
		ur := toUserResponse(*p.User)
		resp.User = &ur
	}
	if p.APIKey != nil {
		kr := toAPIKeyResponse(*p.APIKey)
		resp.APIKey = &kr
	}
	writeJSON(w, http.StatusOK, resp)
}

type changePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

// handleChangePassword lets a user rotate their own password. All other
// sessions for the user are revoked.
func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	p := principalFrom(r.Context())
	var req changePasswordRequest
	if err := decodeJSON(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	if !auth.VerifyPassword(p.User.PasswordHash, req.CurrentPassword) {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "current password is incorrect")
		return
	}
	if err := auth.ValidatePassword(req.NewPassword); err != nil {
		s.fail(w, r, errBadRequest(err.Error()))
		return
	}
	hash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	err = s.PG.WithTx(r.Context(), func(q *sqlc.Queries) error {
		if err := q.SetUserPassword(r.Context(), sqlc.SetUserPasswordParams{ID: p.User.ID, PasswordHash: hash}); err != nil {
			return err
		}
		return q.DeleteSessionsForUser(r.Context(), p.User.ID)
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	// Re-issue a session for the current browser so the user stays logged in.
	token, err := s.sessions.create(r.Context(), p.User.ID, s.Cfg.SessionTTL, r)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	setSessionCookie(w, token, s.Cfg.SessionTTL, s.Cfg.SecureCookies)
	w.WriteHeader(http.StatusNoContent)
}
