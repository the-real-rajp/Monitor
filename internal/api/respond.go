package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

// errorBody is the JSON shape of every error response.
type errorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(true)
	_ = enc.Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	var b errorBody
	b.Error.Code = code
	b.Error.Message = message
	writeJSON(w, status, b)
}

// apiError lets handlers return a typed error that maps to a status code.
type apiError struct {
	status  int
	code    string
	message string
}

func (e *apiError) Error() string { return e.message }

func errBadRequest(msg string) error { return &apiError{http.StatusBadRequest, "bad_request", msg} }
func errNotFound(msg string) error   { return &apiError{http.StatusNotFound, "not_found", msg} }
func errConflict(msg string) error   { return &apiError{http.StatusConflict, "conflict", msg} }

// fail writes err as a response. Unknown errors become a 500 and are logged.
func (s *Server) fail(w http.ResponseWriter, r *http.Request, err error) {
	var ae *apiError
	if errors.As(err, &ae) {
		writeError(w, ae.status, ae.code, ae.message)
		return
	}
	s.Log.Error("request failed", "method", r.Method, "path", r.URL.Path, "err", err)
	writeError(w, http.StatusInternalServerError, "internal", "internal error")
}

const maxBodyBytes = 1 << 20

// decodeJSON reads a JSON body into v, rejecting unknown fields and bodies
// over 1 MiB.
func decodeJSON(r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return errBadRequest("request body too large")
		}
		return errBadRequest(fmt.Sprintf("invalid JSON body: %v", err))
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errBadRequest("request body must contain a single JSON object")
	}
	return nil
}
