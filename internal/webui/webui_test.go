package webui

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestSPAHandler(t *testing.T) {
	fsys := fstest.MapFS{
		"index.html":       {Data: []byte("<html>app</html>")},
		"assets/app.1.js":  {Data: []byte("js")},
		"favicon.svg":      {Data: []byte("<svg/>")},
		"assets/style.css": {Data: []byte("css")},
	}
	h := spaHandler(fsys)
	cases := []struct {
		path      string
		wantBody  string
		wantCache string
	}{
		{"/", "<html>app</html>", "no-cache"},
		{"/login", "<html>app</html>", "no-cache"},
		{"/settings/users/abc", "<html>app</html>", "no-cache"},
		{"/assets/app.1.js", "js", "public, max-age=31536000, immutable"},
		{"/favicon.svg", "<svg/>", ""},
	}
	for _, c := range cases {
		t.Run(c.path, func(t *testing.T) {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, c.path, nil))
			body, _ := io.ReadAll(w.Body)
			if w.Code != 200 || string(body) != c.wantBody {
				t.Errorf("got %d %q", w.Code, body)
			}
			if got := w.Header().Get("Cache-Control"); got != c.wantCache {
				t.Errorf("cache-control %q, want %q", got, c.wantCache)
			}
		})
	}
}
