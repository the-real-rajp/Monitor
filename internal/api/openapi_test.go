package api

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
)

// TestOpenAPIContract keeps api/openapi.yaml and the router in lock step:
// the document must be valid, every route the server registers must be
// documented with the same method, and every documented operation must be
// served. Adding an endpoint to one side without the other fails CI.
func TestOpenAPIContract(t *testing.T) {
	specPath := filepath.Join("..", "..", "api", "openapi.yaml")
	if _, err := os.Stat(specPath); err != nil {
		t.Fatalf("spec not found: %v", err)
	}
	loader := openapi3.NewLoader()
	doc, err := loader.LoadFromFile(specPath)
	if err != nil {
		t.Fatalf("load spec: %v", err)
	}
	if err := doc.Validate(context.Background()); err != nil {
		t.Fatalf("spec invalid: %v", err)
	}

	documented := map[string]bool{}
	for p, item := range doc.Paths.Map() {
		for method := range item.Operations() {
			documented[method+" "+p] = true
		}
	}

	s := &Server{}
	served := map[string]bool{}
	for _, r := range s.Routes() {
		key := r.Method + " " + muxToOpenAPIPath(r.Pattern)
		served[key] = true
		if !documented[key] {
			t.Errorf("route %s is served but not documented in openapi.yaml", key)
		}
	}
	for key := range documented {
		if !served[key] {
			t.Errorf("operation %s is documented but not served", key)
		}
	}
}

var muxParam = regexp.MustCompile(`\{([a-zA-Z0-9_]+)(\.\.\.)?\}`)

// muxToOpenAPIPath converts a net/http pattern like /users/{id} to the
// OpenAPI form, which is the same except for wildcard suffixes.
func muxToOpenAPIPath(p string) string {
	p = strings.TrimSuffix(p, "/{$}")
	return muxParam.ReplaceAllString(p, "{$1}")
}

// TestRoutesHaveExplicitAuth guards against a new route silently defaulting
// to public: anything under /api/v1 other than the login and public system
// endpoints must require authentication.
func TestRoutesHaveExplicitAuth(t *testing.T) {
	public := map[string]bool{
		"POST /api/v1/auth/login": true,
		"GET /api/v1/version":     true,
	}
	s := &Server{}
	for _, r := range s.Routes() {
		key := r.Method + " " + r.Pattern
		if strings.HasPrefix(r.Pattern, "/api/") && r.Auth == authNone && !public[key] {
			t.Errorf("%s is public; add it to the allowlist in this test if that is intended", key)
		}
	}
}
