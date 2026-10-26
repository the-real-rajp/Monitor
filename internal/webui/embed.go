//go:build embedweb

package webui

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed all:dist
var dist embed.FS

// Handler serves the embedded production build.
func Handler() http.Handler {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err)
	}
	return spaHandler(sub)
}

// Embedded reports whether the UI is compiled in.
const Embedded = true
