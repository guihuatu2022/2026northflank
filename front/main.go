// Command server is the entrypoint of the container image.
//
// It has three responsibilities:
//
//  1. render the sing-box configuration from environment variables and write
//     it to a location the unprivileged user can reach,
//  2. act as PID 1 for the sing-box child: start it, wait for it to listen,
//     forward termination signals and exit when it dies,
//  3. serve the public port, reverse proxying only the secret WebSocket prefix
//     to the local sing-box listener and answering everything else with one
//     uniform 404.
//
// All configuration comes from the environment, so the image itself never
// contains a credential.
package main

import (
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"runtime/debug"
	"strings"
	"syscall"
	"time"
)

const (
	lvlError = iota
	lvlWarn
	lvlInfo
	lvlDebug
)

var currentLogLevel = lvlWarn

func logf(level int, format string, args ...any) {
	if level <= currentLogLevel {
		log.Printf(format, args...)
	}
}

// debugLogWriter routes net/http's internal error log to the debug level so
// that client-side noise stays hidden by default but remains reachable.
type debugLogWriter struct{}

func (debugLogWriter) Write(p []byte) (int, error) {
	logf(lvlDebug, "http: %s", strings.TrimRight(string(p), "\n"))
	return len(p), nil
}

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)
	log.SetPrefix("")

	cfg, err := loadConfig()
	if err != nil {
		// Configuration problems are the operator's, not the platform's:
		// report them plainly and exit without starting anything.
		log.SetOutput(os.Stderr)
		log.Printf("configuration error: %v", err)
		os.Exit(2)
	}
	currentLogLevel = cfg.logLevelNum()

	runtime.GOMAXPROCS(cfg.GoMaxProcs)
	debug.SetMemoryLimit(cfg.MemLimitFrontBytes)

	logf(lvlInfo, "starting: listen=%s upstream=%s max_conns=%d early_data=%d",
		cfg.ListenAddr(), cfg.UpstreamAddr(), cfg.MaxConns, cfg.MaxEarlyData)

	rendered, err := cfg.renderSingboxConfig()
	if err != nil {
		logf(lvlError, "cannot render configuration: %v", err)
		os.Exit(1)
	}
	configPath, err := cfg.writeSingboxConfig(rendered)
	if err != nil {
		logf(lvlError, "%v", err)
		os.Exit(1)
	}
	logf(lvlDebug, "wrote runtime configuration to %s", configPath)

	child := exec.Command(cfg.SingboxBin, "run", "-c", configPath)
	child.Env = cfg.childEnv()
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	if err := child.Start(); err != nil {
		logf(lvlError, "cannot start upstream process: %v", err)
		os.Exit(1)
	}
	childDone := make(chan error, 1)
	go func() { childDone <- child.Wait() }()

	if err := waitForListener(cfg.UpstreamAddr(), time.Duration(cfg.ReadyTimeout)*time.Second); err != nil {
		logf(lvlError, "%v", err)
		_ = child.Process.Kill()
		os.Exit(1)
	}
	logf(lvlInfo, "upstream is listening")

	srv := &http.Server{
		Addr:    cfg.ListenAddr(),
		Handler: newHandler(cfg),
		// Only the header timeout is set on purpose: ReadTimeout and
		// WriteTimeout also apply to hijacked connections and would tear down
		// long-lived tunnels.
		ReadHeaderTimeout: 20 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          log.New(debugLogWriter{}, "", 0),
	}

	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.ListenAndServe() }()
	logf(lvlInfo, "serving on %s", cfg.ListenAddr())

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)

	select {
	case sig := <-signals:
		logf(lvlInfo, "received %s, shutting down", sig)
		_ = child.Process.Signal(syscall.SIGTERM)
		select {
		case <-childDone:
		case <-time.After(10 * time.Second):
			logf(lvlWarn, "upstream did not exit in time, killing it")
			_ = child.Process.Kill()
		}
		_ = srv.Close()
		os.Exit(0)

	case err := <-childDone:
		logf(lvlError, "upstream exited: %v", err)
		_ = srv.Close()
		os.Exit(1)

	case err := <-serveErr:
		if err != nil && err != http.ErrServerClosed {
			logf(lvlError, "http server failed: %v", err)
			_ = child.Process.Signal(syscall.SIGTERM)
			os.Exit(1)
		}
	}
}

// waitForListener polls the local listener until it accepts a connection, so
// the public port is not opened before the tunnel can actually be served.
func waitForListener(addr string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, 300*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return nil
		}
		lastErr = err
		time.Sleep(100 * time.Millisecond)
	}
	return &waitError{addr: addr, cause: lastErr}
}

type waitError struct {
	addr  string
	cause error
}

func (e *waitError) Error() string {
	return "upstream listener " + e.addr + " did not become ready: " + e.cause.Error()
}
