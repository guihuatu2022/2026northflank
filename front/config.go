package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const (
	defaultListenPort   = 8080
	defaultUpstreamPort = 9000
	defaultMaxEarlyData = 2048
	defaultMaxConns     = 300
	// originKeyHeader is the header the Cloudflare Worker adds on the
	// edge -> origin leg only. It is never visible to end users.
	originKeyHeader = "X-Origin-Key"
)

var uuidRe = regexp.MustCompile(
	`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// blockedUUIDs are placeholder values that circulate in tutorials and images.
// Accepting them would turn a public image into an open relay for anyone who
// pulls it and forgets to set NODE_ID.
var blockedUUIDs = map[string]bool{
	"de04add9-5c68-8bab-950c-08cd5320df18": true,
	"b831381d-6324-4d53-ad4f-8cda48b30811": true,
	"27848739-7e62-4138-9fd3-098a63964b6b": true,
	"00000000-0000-0000-0000-000000000000": true,
	"11111111-1111-1111-1111-111111111111": true,
}

// blockedPaths are WebSocket paths that scanners and fingerprinting rules look
// for. The path is the primary anti-probing secret, so a guessable one must be
// rejected at startup.
var blockedPaths = map[string]bool{
	"/ws": true, "/wss": true, "/vless": true, "/vmess": true, "/trojan": true,
	"/proxy": true, "/node": true, "/api/ws": true, "/websocket": true,
}

// Config is the fully validated runtime configuration.
type Config struct {
	NodeID       string
	WSPath       string
	ListenPort   int
	UpstreamPort int
	LogLevel     string
	MaxEarlyData int
	EarlyDataHdr string
	MaxConns     int
	OriginSecret string

	SingboxBin   string
	ConfigPath   string
	ReadyTimeout int // seconds to wait for the sing-box listener

	MemLimitSingboxBytes int64
	MemLimitFrontBytes   int64
	GoMaxProcs           int
}

func envStr(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		v = strings.TrimSpace(v)
		if v != "" {
			return v
		}
	}
	return def
}

func envInt(key string, def int) (int, error) {
	v, ok := os.LookupEnv(key)
	if !ok || strings.TrimSpace(v) == "" {
		return def, nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer, got %q", key, v)
	}
	return n, nil
}

func envInt64MB(key string, def int64) (int64, error) {
	v, ok := os.LookupEnv(key)
	if !ok || strings.TrimSpace(v) == "" {
		return def, nil
	}
	n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer (MiB), got %q", key, v)
	}
	return n << 20, nil
}

// loadConfig reads and validates every environment variable. It fails fast and
// loudly: a missing NODE_ID or WS_PATH must never fall back to a default.
func loadConfig() (*Config, error) {
	c := &Config{}

	c.NodeID = envStr("NODE_ID", "")
	if c.NodeID == "" {
		return nil, fmt.Errorf("NODE_ID is required: set it to a randomly generated UUID (for example `uuidgen`)")
	}
	if !uuidRe.MatchString(c.NodeID) {
		return nil, fmt.Errorf("NODE_ID is not a valid UUID")
	}
	if blockedUUIDs[strings.ToLower(c.NodeID)] {
		return nil, fmt.Errorf("NODE_ID is a well-known example value; generate your own UUID")
	}

	c.WSPath = envStr("WS_PATH", "")
	if c.WSPath == "" {
		return nil, fmt.Errorf("WS_PATH is required: set it to a long random path beginning with '/'")
	}
	switch {
	case !strings.HasPrefix(c.WSPath, "/"):
		return nil, fmt.Errorf("WS_PATH must begin with '/'")
	case len(c.WSPath) < 16:
		return nil, fmt.Errorf("WS_PATH must be at least 16 characters long")
	case strings.HasSuffix(c.WSPath, "/"):
		return nil, fmt.Errorf("WS_PATH must not end with '/' (it would make prefix matching ambiguous)")
	case strings.ContainsAny(c.WSPath, " \t\r\n?#%"):
		// '%' is rejected because the path is compared after URL decoding, and
		// percent escapes would make the prefix test disagree with what the
		// client actually sent.
		return nil, fmt.Errorf("WS_PATH must not contain whitespace, '?', '#' or '%%'")
	}
	if blockedPaths[strings.ToLower(c.WSPath)] {
		return nil, fmt.Errorf("WS_PATH %q is a well-known value; use a long random path", c.WSPath)
	}

	var err error
	if c.ListenPort, err = envInt("LISTEN_PORT", defaultListenPort); err != nil {
		return nil, err
	}
	if c.ListenPort < 1 || c.ListenPort > 65535 {
		return nil, fmt.Errorf("LISTEN_PORT out of range: %d", c.ListenPort)
	}
	if c.UpstreamPort, err = envInt("UPSTREAM_PORT", defaultUpstreamPort); err != nil {
		return nil, err
	}
	if c.UpstreamPort < 1 || c.UpstreamPort > 65535 {
		return nil, fmt.Errorf("UPSTREAM_PORT out of range: %d", c.UpstreamPort)
	}
	if c.UpstreamPort == c.ListenPort {
		return nil, fmt.Errorf("UPSTREAM_PORT must differ from LISTEN_PORT")
	}
	if c.MaxEarlyData, err = envInt("MAX_EARLY_DATA", defaultMaxEarlyData); err != nil {
		return nil, err
	}
	if c.MaxEarlyData < 0 || c.MaxEarlyData > 8192 {
		return nil, fmt.Errorf("MAX_EARLY_DATA out of range (0 disables early data): %d", c.MaxEarlyData)
	}
	if c.MaxConns, err = envInt("MAX_CONNS", defaultMaxConns); err != nil {
		return nil, err
	}
	if c.MaxConns < 1 {
		return nil, fmt.Errorf("MAX_CONNS must be at least 1")
	}
	if c.ReadyTimeout, err = envInt("READY_TIMEOUT", 20); err != nil {
		return nil, err
	}

	c.LogLevel = strings.ToLower(envStr("LOG_LEVEL", "warn"))
	switch c.LogLevel {
	case "error", "warn", "info", "debug":
	default:
		return nil, fmt.Errorf("LOG_LEVEL must be one of error, warn, info, debug")
	}

	c.EarlyDataHdr = envStr("EARLY_DATA_HEADER", "")
	c.OriginSecret = envStr("ORIGIN_SECRET", "")
	c.SingboxBin = envStr("SINGBOX_BIN", "/app/engine")
	c.ConfigPath = envStr("CONFIG_PATH", "")

	// Memory: derive from the real cgroup limit unless explicitly overridden.
	// Two processes share one cgroup, so the shares must be per-process.
	limit := detectMemoryLimitBytes()
	defSingbox := limit * 55 / 100
	defFront := limit * 15 / 100
	if c.MemLimitSingboxBytes, err = envInt64MB("SINGBOX_MEMLIMIT_MB", defSingbox>>20); err != nil {
		return nil, err
	}
	if c.MemLimitFrontBytes, err = envInt64MB("FRONT_MEMLIMIT_MB", defFront>>20); err != nil {
		return nil, err
	}

	// CPU: 0.2 vCPU should not run the Go scheduler with more than one P.
	c.GoMaxProcs = runtimeGoMaxProcs()

	return c, nil
}

// runtimeGoMaxProcs clamps GOMAXPROCS to the detected CPU quota.
func runtimeGoMaxProcs() int {
	if v := envStr("GOMAXPROCS", ""); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	if q := detectCPUQuota(); q > 0 {
		if q < 1 {
			return 1
		}
		if n := int(q); n >= 1 {
			return n
		}
	}
	return 0 // 0 lets the Go runtime decide
}

func (c *Config) ListenAddr() string   { return fmt.Sprintf(":%d", c.ListenPort) }
func (c *Config) UpstreamAddr() string { return fmt.Sprintf("127.0.0.1:%d", c.UpstreamPort) }

func (c *Config) logLevelNum() int {
	switch c.LogLevel {
	case "error":
		return lvlError
	case "warn":
		return lvlWarn
	case "info":
		return lvlInfo
	default:
		return lvlDebug
	}
}

// childEnv builds the environment for the sing-box process, applying the
// per-process memory limit and GOMAXPROCS. os/exec keeps the last value for a
// duplicated key, so these override anything inherited.
func (c *Config) childEnv() []string {
	env := os.Environ()
	env = append(env, fmt.Sprintf("GOMEMLIMIT=%dMiB", c.MemLimitSingboxBytes>>20))
	if c.GoMaxProcs > 0 {
		env = append(env, fmt.Sprintf("GOMAXPROCS=%d", c.GoMaxProcs))
	}
	return env
}

// --- sing-box configuration -------------------------------------------------

type sbLog struct {
	Level     string `json:"level"`
	Timestamp bool   `json:"timestamp"`
}

type sbUser struct {
	UUID string `json:"uuid"`
	Flow string `json:"flow"`
}

type sbTransport struct {
	Type         string `json:"type"`
	Path         string `json:"path"`
	MaxEarlyData int    `json:"max_early_data,omitempty"`
	EarlyDataHdr string `json:"early_data_header_name,omitempty"`
}

type sbInbound struct {
	Type       string      `json:"type"`
	Tag        string      `json:"tag"`
	Listen     string      `json:"listen"`
	ListenPort int         `json:"listen_port"`
	Users      []sbUser    `json:"users"`
	Transport  sbTransport `json:"transport"`
}

type sbOutbound struct {
	Type           string `json:"type"`
	Tag            string `json:"tag"`
	TCPFastOpen    bool   `json:"tcp_fast_open"`
	ConnectTimeout string `json:"connect_timeout"`
}

type sbRoute struct {
	Final string `json:"final"`
}

type sbConfig struct {
	Log       sbLog        `json:"log"`
	Inbounds  []sbInbound  `json:"inbounds"`
	Outbounds []sbOutbound `json:"outbounds"`
	Route     sbRoute      `json:"route"`
}

// renderSingboxConfig produces the smallest configuration that serves
// VLESS over WebSocket and dials out directly. Everything else (DNS block,
// routing rules, rule-sets, experimental APIs, sniffing) is deliberately
// omitted: it costs memory, and those are exactly the areas that change
// between sing-box releases.
func (c *Config) renderSingboxConfig() ([]byte, error) {
	cfg := sbConfig{
		Log: sbLog{Level: c.LogLevel, Timestamp: true},
		Inbounds: []sbInbound{{
			Type:       "vless",
			Tag:        "in",
			Listen:     "127.0.0.1",
			ListenPort: c.UpstreamPort,
			Users:      []sbUser{{UUID: c.NodeID, Flow: ""}},
			Transport: sbTransport{
				Type:         "ws",
				Path:         c.WSPath,
				MaxEarlyData: c.MaxEarlyData,
				EarlyDataHdr: c.EarlyDataHdr,
			},
		}},
		Outbounds: []sbOutbound{{
			Type:           "direct",
			Tag:            "out",
			TCPFastOpen:    true,
			ConnectTimeout: "5s",
		}},
		Route: sbRoute{Final: "out"},
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

// writeSingboxConfig writes the rendered configuration to the first writable
// candidate location. The image is distroless and runs unprivileged, so the
// candidates are tried in order instead of assuming one path exists.
func (c *Config) writeSingboxConfig(data []byte) (string, error) {
	var candidates []string
	if c.ConfigPath != "" {
		candidates = append(candidates, c.ConfigPath)
	}
	candidates = append(candidates, "/app/config.json", "/tmp/config.json", "/dev/shm/config.json")

	var lastErr error
	for _, p := range candidates {
		if dir := filepath.Dir(p); dir != "" && dir != "/" {
			_ = os.MkdirAll(dir, 0o755)
		}
		f, err := os.OpenFile(p, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
		if err != nil {
			lastErr = err
			continue
		}
		_, err = f.Write(data)
		cerr := f.Close()
		if err != nil {
			lastErr = err
			continue
		}
		if cerr != nil {
			lastErr = cerr
			continue
		}
		return p, nil
	}
	return "", fmt.Errorf("no writable location for the runtime configuration: %w", lastErr)
}
