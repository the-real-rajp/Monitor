//go:build !embedweb

package webui

import "net/http"

const placeholder = `<!doctype html>
<html><head><meta charset="utf-8"><title>Monitor</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222}code{background:#eee;padding:.1em .3em;border-radius:3px}</style>
</head><body>
<h1>Monitor API is running</h1>
<p>This binary was built without the web UI. Either:</p>
<ul>
<li>run the UI in development mode with <code>make dev-web</code> (it proxies API calls here), or</li>
<li>build with the UI embedded: <code>make build</code>.</li>
</ul>
<p>The API is served under <code>/api/v1/</code>. Health: <a href="/healthz">/healthz</a>, readiness: <a href="/readyz">/readyz</a>.</p>
</body></html>`

// Handler serves a placeholder page explaining that the UI is not embedded.
func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(placeholder))
	})
}

// Embedded reports whether the UI is compiled in.
const Embedded = false
