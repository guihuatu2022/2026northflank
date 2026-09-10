package main

import (
	"crypto/subtle"
	"net"
	"net/http"
	"net/http/httputil"
	"strings"
	"time"
)

// newHandler returns the public-port handler.
//
// Behaviour, in order:
//   - anything that does not carry the secret prefix gets an identical 404,
//   - the secret prefix without a WebSocket upgrade gets the same 404,
//   - the secret prefix with an upgrade but a wrong origin key gets it too,
//   - otherwise the request is proxied to the local sing-box listener.
//
// The prefix test (rather than an exact match) is required because clients
// append early data to the path when early data is enabled.
func newHandler(cfg *Config) http.Handler {
	upstream := cfg.UpstreamAddr()

	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme = "http"
			pr.Out.URL.Host = upstream
			pr.Out.Host = upstream
			// Do not forward client-identifying headers to the local listener,
			// and never create them (SetXForwarded is deliberately not called).
			for _, h := range []string{
				"X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-Ip",
			} {
				pr.Out.Header.Del(h)
			}
		},
		// -1 disables response buffering, which a WebSocket needs.
		FlushInterval: -1,
		Transport: &http.Transport{
			DialContext: (&net.Dialer{
				Timeout:   10 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			MaxIdleConns:          64,
			IdleConnTimeout:       90 * time.Second,
			DisableCompression:    true,
			ForceAttemptHTTP2:     false,
			ExpectContinueTimeout: 1 * time.Second,
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			// Never surface upstream errors: they would describe the origin.
			logf(lvlDebug, "upstream error: %v", err)
			writeNotFound(w)
		},
	}

	// Connection ceiling. On 0.2 vCPU the container runs out of CPU long
	// before it runs out of memory, so the limit protects throughput for
	// everyone rather than RAM.
	sem := make(chan struct{}, cfg.MaxConns)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, cfg.WSPath) {
			writeNotFound(w)
			return
		}
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || !cfg.originKeyOK(r) {
			writeNotFound(w)
			return
		}
		select {
		case sem <- struct{}{}:
			defer func() { <-sem }()
		default:
			logf(lvlWarn, "connection limit reached (%d concurrent)", cfg.MaxConns)
			writeServiceUnavailable(w)
			return
		}
		logf(lvlDebug, "proxying websocket")
		proxy.ServeHTTP(w, r)
	})
}

// originKeyOK checks the shared secret the Worker adds on the edge -> origin
// leg. When ORIGIN_SECRET is unset the check is skipped, which is why the
// README recommends setting it.
func (c *Config) originKeyOK(r *http.Request) bool {
	if c.OriginSecret == "" {
		return true
	}
	got := r.Header.Get(originKeyHeader)
	return subtle.ConstantTimeCompare([]byte(got), []byte(c.OriginSecret)) == 1
}
