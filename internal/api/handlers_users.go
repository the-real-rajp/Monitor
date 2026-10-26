package api

import (
	"errors"
	"net/http"
	"net/mail"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/the-real-rajp/monitor/internal/auth"
	"github.com/the-real-rajp/monitor/internal/store/pg/sqlc"
)

func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	p := principalFrom(r.Context())
	users, err := s.PG.Q.ListUsersByOrg(r.Context(), p.OrgID)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	out := make([]userResponse, 0, len(users))
	for _, u := range users {
		out = append(out, toUserResponse(u))
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": out})
}

type createUserRequest struct {
	Email    string `json:"email"`
	Name     string `json:"name"`
	Role     string `json:"role"`
	Password string `json:"password"`
}

func parseRole(s string) (sqlc.UserRole, bool) {
	r := sqlc.UserRole(s)
	return r, r.Valid()
}

// NormalizeEmail validates and lower-cases an email address.
func NormalizeEmail(s string) (string, error) {
	s = strings.TrimSpace(strings.ToLower(s))
	if s == "" {
		return "", errors.New("email is required")
	}
	addr, err := mail.ParseAddress(s)
	if err != nil || addr.Address != s {
		return "", errors.New("email is not a valid address")
	}
	return s, nil
}

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	p := principalFrom(r.Context())
	var req createUserRequest
	if err := decodeJSON(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	email, err := NormalizeEmail(req.Email)
	if err != nil {
		s.fail(w, r, errBadRequest(err.Error()))
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		s.fail(w, r, errBadRequest("name is required"))
		return
	}
	role, ok := parseRole(req.Role)
	if !ok {
		s.fail(w, r, errBadRequest("role must be admin, member or viewer"))
		return
	}
	if err := auth.ValidatePassword(req.Password); err != nil {
		s.fail(w, r, errBadRequest(err.Error()))
		return
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		s.fail(w, r, err)
		return
	}
	u, err := s.PG.Q.CreateUser(r.Context(), sqlc.CreateUserParams{
		OrgID: p.OrgID, Email: email, Name: req.Name, Role: role, PasswordHash: hash,
	})
	if err != nil {
		if isUniqueViolation(err) {
			s.fail(w, r, errConflict("a user with that email already exists"))
			return
		}
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, toUserResponse(u))
}

func (s *Server) handleGetUser(w http.ResponseWriter, r *http.Request) {
	p := principalFrom(r.Context())
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		s.fail(w, r, errNotFound("user not found"))
		return
	}
	u, err := s.PG.Q.GetUser(r.Context(), id)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && u.OrgID != p.OrgID) {
		s.fail(w, r, errNotFound("user not found"))
		return
	}
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toUserResponse(u))
}

type updateUserRequest struct {
	Name     *string `json:"name,omitempty"`
	Role     *string `json:"role,omitempty"`
	Disabled *bool   `json:"disabled,omitempty"`
	Password *string `json:"password,omitempty"`
}

// handleUpdateUser changes name, role, disabled state or password. The last
// active admin cannot be demoted or disabled, so an org can never lock
// itself out.
func (s *Server) handleUpdateUser(w http.ResponseWriter, r *http.Request) {
	p := principalFrom(r.Context())
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		s.fail(w, r, errNotFound("user not found"))
		return
	}
	var req updateUserRequest
	if err := decodeJSON(r, &req); err != nil {
		s.fail(w, r, err)
		return
	}
	params := sqlc.UpdateUserParams{ID: id, OrgID: p.OrgID}
	if req.Name != nil {
		n := strings.TrimSpace(*req.Name)
		if n == "" {
			s.fail(w, r, errBadRequest("name cannot be empty"))
			return
		}
		params.Name = &n
	}
	if req.Role != nil {
		role, ok := parseRole(*req.Role)
		if !ok {
			s.fail(w, r, errBadRequest("role must be admin, member or viewer"))
			return
		}
		params.Role = sqlc.NullUserRole{UserRole: role, Valid: true}
	}
	var newHash string
	if req.Password != nil {
		if err := auth.ValidatePassword(*req.Password); err != nil {
			s.fail(w, r, errBadRequest(err.Error()))
			return
		}
		newHash, err = auth.HashPassword(*req.Password)
		if err != nil {
			s.fail(w, r, err)
			return
		}
	}

	var out sqlc.User
	err = s.PG.WithTx(r.Context(), func(q *sqlc.Queries) error {
		cur, err := q.GetUser(r.Context(), id)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && cur.OrgID != p.OrgID) {
			return errNotFound("user not found")
		}
		if err != nil {
			return err
		}
		losingAdmin := cur.Role == sqlc.UserRoleAdmin && cur.DisabledAt == nil &&
			((params.Role.Valid && params.Role.UserRole != sqlc.UserRoleAdmin) || (req.Disabled != nil && *req.Disabled))
		if losingAdmin {
			n, err := q.CountUsersByOrgAndRole(r.Context(), sqlc.CountUsersByOrgAndRoleParams{OrgID: p.OrgID, Role: sqlc.UserRoleAdmin})
			if err != nil {
				return err
			}
			if n <= 1 {
				return errConflict("cannot remove the last admin")
			}
		}
		out, err = q.UpdateUser(r.Context(), params)
		if err != nil {
			return err
		}
		if req.Disabled != nil {
			out, err = q.SetUserDisabled(r.Context(), sqlc.SetUserDisabledParams{ID: id, OrgID: p.OrgID, Disabled: *req.Disabled})
			if err != nil {
				return err
			}
			if *req.Disabled {
				if err := q.DeleteSessionsForUser(r.Context(), id); err != nil {
					return err
				}
			}
		}
		if newHash != "" {
			if err := q.SetUserPassword(r.Context(), sqlc.SetUserPasswordParams{ID: id, PasswordHash: newHash}); err != nil {
				return err
			}
			if err := q.DeleteSessionsForUser(r.Context(), id); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, toUserResponse(out))
}

func (s *Server) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	p := principalFrom(r.Context())
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		s.fail(w, r, errNotFound("user not found"))
		return
	}
	if id == p.User.ID {
		s.fail(w, r, errConflict("you cannot delete your own account"))
		return
	}
	err = s.PG.WithTx(r.Context(), func(q *sqlc.Queries) error {
		cur, err := q.GetUser(r.Context(), id)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && cur.OrgID != p.OrgID) {
			return errNotFound("user not found")
		}
		if err != nil {
			return err
		}
		if cur.Role == sqlc.UserRoleAdmin && cur.DisabledAt == nil {
			n, err := q.CountUsersByOrgAndRole(r.Context(), sqlc.CountUsersByOrgAndRoleParams{OrgID: p.OrgID, Role: sqlc.UserRoleAdmin})
			if err != nil {
				return err
			}
			if n <= 1 {
				return errConflict("cannot delete the last admin")
			}
		}
		_, err = q.DeleteUser(r.Context(), sqlc.DeleteUserParams{ID: id, OrgID: p.OrgID})
		return err
	})
	if err != nil {
		s.fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
