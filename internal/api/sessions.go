package api

import (
	"context"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/the-real-rajp/monitor/internal/auth"
	"github.com/the-real-rajp/monitor/internal/store/pg"
	"github.com/the-real-rajp/monitor/internal/store/pg/sqlc"
)

// sessionStore wraps the session queries with token handling.
type sessionStore struct {
	db *pg.DB
}

// create issues a new session and returns the raw token for the cookie.
func (s sessionStore) create(ctx context.Context, userID uuid.UUID, ttl time.Duration, r *http.Request) (string, error) {
	token, hash, err := auth.NewSessionToken()
	if err != nil {
		return "", err
	}
	ua := r.UserAgent()
	if len(ua) > 512 {
		ua = ua[:512]
	}
	ip := clientIP(r)
	var ipp *string
	if ip != "" {
		ipp = &ip
	}
	err = s.db.Q.CreateSession(ctx, sqlc.CreateSessionParams{
		TokenHash: hash,
		UserID:    userID,
		ExpiresAt: time.Now().Add(ttl),
		UserAgent: ua,
		Ip:        ipp,
	})
	if err != nil {
		return "", err
	}
	return token, nil
}

// touch extends a session. Called from a goroutine, so it owns its context.
func (s sessionStore) touch(hash []byte, ttl time.Duration) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = s.db.Q.TouchSession(ctx, sqlc.TouchSessionParams{TokenHash: hash, ExpiresAt: time.Now().Add(ttl)})
}

func (s sessionStore) delete(ctx context.Context, hash []byte) error {
	return s.db.Q.DeleteSession(ctx, hash)
}

func setSessionCookie(w http.ResponseWriter, token string, ttl time.Duration, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		MaxAge:   int(ttl.Seconds()),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
}

func clearSessionCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
}
