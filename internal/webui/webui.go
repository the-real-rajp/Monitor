// Package webui serves the React application. The built app is embedded
// into the server binary when compiled with -tags embedweb (what `make
// build` and the Dockerfile do). Without the tag, a placeholder page
// explains how to run the UI in development mode, so `go run ./cmd/server`
// works with no Node toolchain.
package webui

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// spaHandler serves static files from fsys and falls back to index.html for
// any path that is not a file, so client-side routing works on reload.
func spaHandler(fsys fs.FS) http.Handler {
	fileServer := http.FileServerFS(fsys)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if p == "" {
			p = "index.html"
		}
		if f, err := fsys.Open(p); err == nil {
			_ = f.Close()
			switch {
			case strings.HasPrefix(p, "assets/"):
				// Vite emits content-hashed filenames under assets/.
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			case p == "index.html":
				w.Header().Set("Cache-Control", "no-cache")
			}
			fileServer.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	})
}
