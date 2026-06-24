package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// SIEM forwarding — mirror the audit events recorded in the events table
// (see bailey_store_audit.go) to an external OpenTelemetry ingestor, so an
// operator can stream Bailey's security audit log into their SIEM.
//
// Transport is OTLP/HTTP with JSON encoding (POST <endpoint>/v1/logs,
// Content-Type application/json), which every OpenTelemetry collector accepts
// and which we can emit from the standard library alone — no SDK/gRPC
// dependency for a low-volume audit stream. The config (endpoint, optional
// port override, optional bearer token) lives in server_settings as JSON;
// forwarding is best-effort and asynchronous so it never blocks or fails the
// underlying mutation that produced the event.

const settingSIEMConfig = "siem_otel_config"

// Supported OTLP transports.
const (
	siemProtocolHTTP = "otlp-http" // OTLP/HTTP with JSON encoding (POST /v1/logs)
	siemProtocolGRPC = "otlp-grpc" // OTLP/gRPC (LogsService/Export)
)

// validSIEMProtocol reports whether p is a transport we implement.
func validSIEMProtocol(p string) bool {
	return p == siemProtocolHTTP || p == siemProtocolGRPC
}

// siemConfig is the persisted SIEM forwarding configuration.
type siemConfig struct {
	Enabled   bool   `json:"enabled"`
	Protocol  string `json:"protocol"`   // currently always siemProtocolHTTP
	Endpoint  string `json:"endpoint"`   // base URL, e.g. https://collector.example.com
	Port      int    `json:"port"`       // optional explicit port override (0 = use the URL's)
	AuthToken string `json:"auth_token"` // optional bearer token (sent as Authorization: Bearer)
}

// siemStatusState is the live connection status, updated on every send
// attempt so the overview card can show connected/disconnected truthfully.
type siemStatusState struct {
	mu          sync.Mutex
	lastOK      time.Time
	lastAttempt time.Time
	lastErr     string
}

var siemStatus siemStatusState

func (s *siemStatusState) record(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.lastAttempt = time.Now()
	if err != nil {
		s.lastErr = err.Error()
		return
	}
	s.lastOK = time.Now()
	s.lastErr = ""
}

func (s *siemStatusState) snapshot() (lastOK time.Time, lastErr string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastOK, s.lastErr
}

// getSIEMConfig reads the persisted config, or a zero (disabled) config when
// none is stored. A malformed stored value is surfaced as an error rather
// than silently treated as "disabled".
func getSIEMConfig() (siemConfig, error) {
	raw, err := dbGetSetting(settingSIEMConfig)
	if err != nil {
		return siemConfig{}, err
	}
	if strings.TrimSpace(raw) == "" {
		return siemConfig{Protocol: siemProtocolHTTP}, nil
	}
	var c siemConfig
	if err := json.Unmarshal([]byte(raw), &c); err != nil {
		return siemConfig{}, fmt.Errorf("stored SIEM config is corrupt: %w", err)
	}
	if c.Protocol == "" {
		c.Protocol = siemProtocolHTTP
	}
	return c, nil
}

func setSIEMConfig(c siemConfig, by string) error {
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return dbSetSetting(settingSIEMConfig, string(b), by)
}

// otlpEndpointURL resolves the OTLP/HTTP logs URL for a config: the base
// endpoint with an optional port override, and "/v1/logs" appended when the
// caller gave only a base (no explicit logs path).
func otlpEndpointURL(c siemConfig) (string, error) {
	raw := strings.TrimSpace(c.Endpoint)
	if raw == "" {
		return "", fmt.Errorf("endpoint is required")
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("invalid endpoint URL: %w", err)
	}
	if u.Host == "" {
		return "", fmt.Errorf("endpoint URL has no host")
	}
	if c.Port > 0 {
		host := u.Hostname()
		u.Host = host + ":" + strconv.Itoa(c.Port)
	}
	// Append the standard OTLP logs path unless the operator already gave one.
	if u.Path == "" || u.Path == "/" {
		u.Path = "/v1/logs"
	}
	return u.String(), nil
}

// otlpFields maps one audit event to the OTLP log-record pieces shared by both
// transports: the event timestamp (unix nanos), the human-readable body, and
// the structured attributes. Keeping this in one place means the HTTP/JSON and
// gRPC/proto encoders emit identical records.
func otlpFields(e eventRecord) (tsNano int64, body string, attrs [][2]string) {
	ts, err := time.Parse(time.RFC3339, e.TS)
	if err != nil {
		ts = time.Now().UTC()
	}
	tsNano = ts.UTC().UnixNano()
	body = strings.TrimSpace(strings.TrimSpace(e.Actor+" "+e.Action) + " " + e.Target)
	attrs = [][2]string{
		{"event.domain", "security.audit"},
		{"event.name", e.Action},
		{"enduser.id", e.Actor},
		{"event.target", e.Target},
	}
	return tsNano, body, attrs
}

// otlpLogPayload builds the OTLP/HTTP JSON body for one audit event. Field
// names follow the OTLP JSON mapping (lowerCamelCase) that collectors expect.
func otlpLogPayload(e eventRecord, host string) ([]byte, error) {
	tsNano, body, fields := otlpFields(e)
	attr := func(k, v string) map[string]any {
		return map[string]any{"key": k, "value": map[string]any{"stringValue": v}}
	}
	recAttrs := make([]any, 0, len(fields))
	for _, kv := range fields {
		recAttrs = append(recAttrs, attr(kv[0], kv[1]))
	}
	payload := map[string]any{
		"resourceLogs": []any{map[string]any{
			"resource": map[string]any{"attributes": []any{
				attr("service.name", "bailey"),
				attr("service.namespace", "bitswan"),
				attr("host.name", host),
			}},
			"scopeLogs": []any{map[string]any{
				"scope": map[string]any{"name": "bailey.audit"},
				"logRecords": []any{map[string]any{
					"timeUnixNano":   strconv.FormatInt(tsNano, 10),
					"severityNumber": 9, // INFO
					"severityText":   "INFO",
					"body":           map[string]any{"stringValue": body},
					"attributes":     recAttrs,
				}},
			}},
		}},
	}
	return json.Marshal(payload)
}

// postOTLP sends one audit event to the configured ingestor synchronously,
// dispatching to the configured transport.
func postOTLP(ctx context.Context, c siemConfig, e eventRecord) error {
	if c.Protocol == siemProtocolGRPC {
		return exportOTLPGRPC(ctx, c, e)
	}
	return postOTLPHTTP(ctx, c, e)
}

// postOTLPHTTP sends one event over OTLP/HTTP (JSON).
func postOTLPHTTP(ctx context.Context, c siemConfig, e eventRecord) error {
	endpoint, err := otlpEndpointURL(c)
	if err != nil {
		return err
	}
	payload, err := otlpLogPayload(e, serverHostName())
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if t := strings.TrimSpace(c.AuthToken); t != "" {
		req.Header.Set("Authorization", "Bearer "+t)
	}
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		buf := make([]byte, 512)
		n, _ := resp.Body.Read(buf)
		return fmt.Errorf("ingestor returned %d: %s", resp.StatusCode, strings.TrimSpace(string(buf[:n])))
	}
	return nil
}

// siemForwardEvent forwards one audit event to the SIEM if forwarding is
// enabled. Best-effort and asynchronous — it must never block or fail the
// caller's mutation. Status (success/error) is recorded for the overview card.
func siemForwardEvent(e eventRecord) {
	cfg, err := getSIEMConfig()
	if err != nil || !cfg.Enabled {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		siemStatus.record(postOTLP(ctx, cfg, e))
	}()
}

// siemSendTest sends a synthetic audit event synchronously and returns the
// result, so "Test / Save" in the UI can report connected/failed immediately.
func siemSendTest(cfg siemConfig) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	test := eventRecord{
		TS:     time.Now().UTC().Format(time.RFC3339),
		Actor:  "bailey",
		Action: "siem.test",
		Target: "connectivity check",
	}
	err := postOTLP(ctx, cfg, test)
	siemStatus.record(err)
	return err
}

// --- HTTP API (admin-only; the caller is already gated in handleBailey) ---

// siemConfigDTO is the JSON returned to the console. The auth token is never
// echoed back (only whether one is set) — it's a secret.
type siemConfigDTO struct {
	Enabled      bool   `json:"enabled"`
	Protocol     string `json:"protocol"`
	Endpoint     string `json:"endpoint"`
	Port         int    `json:"port,omitempty"`
	HasAuthToken bool   `json:"has_auth_token"`
	Connected    bool   `json:"connected"`
	LastError    string `json:"last_error,omitempty"`
	LastEventAt  string `json:"last_event_at,omitempty"`
}

func siemConfigToDTO(c siemConfig) siemConfigDTO {
	lastOK, lastErr := siemStatus.snapshot()
	dto := siemConfigDTO{
		Enabled:      c.Enabled,
		Protocol:     c.Protocol,
		Endpoint:     c.Endpoint,
		Port:         c.Port,
		HasAuthToken: strings.TrimSpace(c.AuthToken) != "",
		LastError:    lastErr,
	}
	// Connected = enabled, a send has succeeded, and there's no newer failure.
	dto.Connected = c.Enabled && !lastOK.IsZero() && lastErr == ""
	if !lastOK.IsZero() {
		dto.LastEventAt = lastOK.UTC().Format(time.RFC3339)
	}
	return dto
}

// handleSIEMGet returns the current SIEM config (token redacted) + live status.
func handleSIEMGet(w http.ResponseWriter, r *http.Request) {
	cfg, err := getSIEMConfig()
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(siemConfigToDTO(cfg))
}

// siemConfigRequest is the POST body. AuthToken is a pointer so the UI can
// PATCH the config without re-sending the secret: nil = keep the stored token,
// "" = clear it, any value = set it.
type siemConfigRequest struct {
	Enabled   bool    `json:"enabled"`
	Protocol  string  `json:"protocol"`
	Endpoint  string  `json:"endpoint"`
	Port      int     `json:"port"`
	AuthToken *string `json:"auth_token"`
	Test      bool    `json:"test"` // when true, send a synchronous test event and report the result
}

// handleSIEMSet validates and persists the SIEM config. When enabled (or when
// `test` is set) it sends a synchronous test event so the UI can show a
// truthful connected/failed result immediately.
func handleSIEMSet(w http.ResponseWriter, r *http.Request, by string) {
	var req siemConfigRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "bad request", http.StatusBadRequest)
		return
	}
	existing, err := getSIEMConfig()
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	protocol := strings.TrimSpace(req.Protocol)
	if protocol == "" {
		protocol = siemProtocolHTTP
	}
	if !validSIEMProtocol(protocol) {
		writeJSONError(w, "unsupported protocol: use "+siemProtocolHTTP+" (OTLP/HTTP) or "+siemProtocolGRPC+" (OTLP/gRPC)", http.StatusBadRequest)
		return
	}
	if req.Port < 0 || req.Port > 65535 {
		writeJSONError(w, "port must be between 0 and 65535", http.StatusBadRequest)
		return
	}
	cfg := siemConfig{
		Enabled:   req.Enabled,
		Protocol:  protocol,
		Endpoint:  strings.TrimSpace(req.Endpoint),
		Port:      req.Port,
		AuthToken: existing.AuthToken, // preserved unless the request overrides it
	}
	if req.AuthToken != nil {
		cfg.AuthToken = strings.TrimSpace(*req.AuthToken)
	}
	// Validate the endpoint up front when enabling, so we never persist an
	// "enabled but unusable" config silently.
	if cfg.Enabled {
		if err := validateSIEMEndpoint(cfg); err != nil {
			writeJSONError(w, err.Error(), http.StatusBadRequest)
			return
		}
	}

	// A connectivity test is requested explicitly, or implied by enabling.
	if req.Test || cfg.Enabled {
		if testErr := siemSendTest(cfg); testErr != nil {
			// Persist the config anyway (so the operator's settings stick), but
			// report the failure so the UI shows "disconnected: <reason>".
			_ = setSIEMConfig(cfg, by)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			dto := siemConfigToDTO(cfg)
			dto.Connected = false
			dto.LastError = testErr.Error()
			_ = json.NewEncoder(w).Encode(dto)
			return
		}
	}
	if err := setSIEMConfig(cfg, by); err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = recordEvent(by, "siem.configure", cfg.Endpoint)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(siemConfigToDTO(cfg))
}

// serverHostName is the public server host for the OTLP resource attribute.
// Derived from the configured protected domain (bailey.<domain>), falling back
// to the OS hostname so the resource is never blank.
func serverHostName() string {
	if dom := configuredProtectedDomain(); dom != "" {
		return serverConsoleHost(dom)
	}
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return "bailey"
}
