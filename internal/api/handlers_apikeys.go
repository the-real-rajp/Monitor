package api

import (
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/the-real-rajp/monitor/internal/auth"
	"github.com/the-real-rajp/monitor/internal/store/pg/sqlc"
)

// APIKeyScopes are the permissions an API key may carry. Phase 0 defines
// them; the ingest and query endpoints that enforce them arrive in phases 1
// to 3.
var APIKeyScopes = []string{"ingest", "read", "write"}

type apiKeyResponse struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Prefix     string     `json:"prefix"`
	Scopes     []string   `json:"scopes"`
	CreatedBy  *string    `json:"created_by"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at"`
	RevokedAt  *time.Time `json:"revoked_at"`
}

type apiKeyCreatedResponse struct {
	apiKeyResponse
	Key string `json:"key"`
}

func toAPIKeyResponse(k sqlc.ApiKey) apiKeyResponse {
	var by *string
	if k.CreatedBy != nil {
		s := k.CreatedBy.String()
		by = &s
	}
	scopes := k.Scopes
	if scopes == nil {
		scopes = []string{}
	}
	return apiKeyResponse{
		ID: k.ID.String(), Name: k.Name, Prefix: k.Prefix, Scopes: scopes,
		CreatedBy: by, CreatedAt: k.CreatedAt, LastUsedAt: k.LastUsedAt, RevokedAt: k.RevokedAt,
	}
}

func (s *Server) handleListAPIKeys(w http.ResponseWriter, r *http.Request) {
	p := principalFrom(r.Context())
	keys, err := s.PG.Q.ListAPIKeysByOrg(r.Context(), p.OrgID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	out := make([]apiKeyResponse, 0, len(keys))
	for _, k := range keys {
		out = append(out, toAPIKeyResponse(k))
	}
	writeJSON(w, http.StatusOK, map[string]any{"api_keys": out})
}

type createAPIKeyRequest struct {
	Name   string   `json:"name"`
	Scopes []string `json:"scopes"`
}

// handleCreateAPIKey mints a key. The full key is returned exactly once.
func (s *Server) handleCreateAPIKey(w http.ResponseWriter, r *http.Request) {
	p := principalFrom(r.Context())
	var req createAPIKeyRequest
	if err := decodeJSON(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len(req.Name) > 100 {
		s.fail(w, r, errBadRequest("name is required and must be at most 100 characters"))
		return
	}
	if len(req.Scopes) == 0 {
		s.fail(w, r, errBadRequest("at least one scope is required"))
		return
	}
	for _, sc := range req.Scopes {
		if !slices.Contains(APIKeyScopes, sc) {
			s.fail(w, r, errBadRequest("unknown scope "+sc+"; valid scopes are "+strings.Join(APIKeyScopes, ", ")))
			return
		}
	}
	slices.Sort(req.Scopes)
	req.Scopes = slices.Compact(req.Scopes)

	key, prefix, hash, err := auth.NewAPIKey()
	if err != nil {
		s.fail(w, r, err)
		return
	}
	k, err := s.PG.Q.CreateAPIKey(r.Context(), sqlc.CreateAPIKeyParams{
		OrgID: p.OrgID, Name: req.Name, Prefix: prefix, KeyHash: hash, Scopes: req.Scopes, CreatedBy: &p.User.ID,
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, apiKeyCreatedResponse{apiKeyResponse: toAPIKeyResponse(k), Key: key})
}

func (s *Server) handleRevokeAPIKey(w http.ResponseWriter, r *http.Request) {
	p := principalFrom(r.Context())
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		s.fail(w, r, errNotFound("api key not found"))
		return
	}
	n, err := s.PG.Q.RevokeAPIKey(r.Context(), sqlc.RevokeAPIKeyParams{ID: id, OrgID: p.OrgID})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	if n == 0 {
		s.fail(w, r, errNotFound("api key not found or already revoked"))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
