package main

import (
	"io"
	"net/http"
	"strconv"
)

// The public port of the origin never serves the real site: the decoy site
// lives at the Cloudflare edge. Anything that reaches the origin directly gets
// one identical response, which keeps active-probing results uniform and gives
// a prober nothing to compare against.
const notFoundHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>404 Not Found</title>
<style>
html{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
background:#fafafa;color:#333}
main{max-width:34rem;padding:2.5rem;text-align:center}
h1{margin:0 0 .5rem;font-size:3rem;font-weight:600;letter-spacing:-.02em}
p{margin:0;color:#666}
@media (prefers-color-scheme:dark){body{background:#161616;color:#ddd}p{color:#999}}
</style>
</head>
<body>
<main>
<h1>404</h1>
<p>The requested resource is not available.</p>
</main>
</body>
</html>
`

func writeHTML(w http.ResponseWriter, status int) {
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Length", strconv.Itoa(len(notFoundHTML)))
	w.WriteHeader(status)
	_, _ = io.WriteString(w, notFoundHTML)
}

// writeNotFound is used for every path, method and malformed request that does
// not match the secret WebSocket prefix.
func writeNotFound(w http.ResponseWriter) { writeHTML(w, http.StatusNotFound) }

// writeServiceUnavailable is only ever reachable on the secret prefix, which is
// never visible to a prober, so a distinct status here leaks nothing.
func writeServiceUnavailable(w http.ResponseWriter) { writeHTML(w, http.StatusServiceUnavailable) }
