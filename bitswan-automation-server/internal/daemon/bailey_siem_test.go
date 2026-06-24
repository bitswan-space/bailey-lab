package daemon

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// otlpReceived mirrors the subset of the OTLP/HTTP JSON we emit, for decoding
// in the test ingestor.
type otlpReceived struct {
	ResourceLogs []struct {
		ScopeLogs []struct {
			LogRecords []struct {
				Body struct {
					StringValue string `json:"stringValue"`
				} `json:"body"`
				Attributes []struct {
					Key   string `json:"key"`
					Value struct {
						StringValue string `json:"stringValue"`
					} `json:"value"`
				} `json:"attributes"`
			} `json:"logRecords"`
		} `json:"scopeLogs"`
	} `json:"resourceLogs"`
}

func (p otlpReceived) firstRecord(t *testing.T) (body string, attrs map[string]string) {
	t.Helper()
	attrs = map[string]string{}
	for _, rl := range p.ResourceLogs {
		for _, sl := range rl.ScopeLogs {
			for _, lr := range sl.LogRecords {
				for _, a := range lr.Attributes {
					attrs[a.Key] = a.Value.StringValue
				}
				return lr.Body.StringValue, attrs
			}
		}
	}
	t.Fatal("OTLP payload had no log records")
	return "", nil
}

// startOTLPReceiver spins up a minimal OpenTelemetry OTLP/HTTP ingestor that
// captures the JSON posted to /v1/logs and the Authorization header.
func startOTLPReceiver(t *testing.T) (*httptest.Server, <-chan otlpReceived, func() string) {
	t.Helper()
	bodies := make(chan otlpReceived, 8)
	// lastAuth is written from each request's handler goroutine and read by the
	// returned accessor; multiple test sends can be in flight at once, so guard
	// it with a mutex (otherwise -race flags concurrent handler writes).
	var (
		mu       sync.Mutex
		lastAuth string
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/logs" {
			http.NotFound(w, r)
			return
		}
		mu.Lock()
		lastAuth = r.Header.Get("Authorization")
		mu.Unlock()
		raw, _ := io.ReadAll(r.Body)
		var p otlpReceived
		if err := json.Unmarshal(raw, &p); err == nil {
			bodies <- p
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	return srv, bodies, func() string {
		mu.Lock()
		defer mu.Unlock()
		return lastAuth
	}
}

func resetSIEM(t *testing.T) {
	t.Helper()
	t.Cleanup(func() { _ = setSIEMConfig(siemConfig{Protocol: siemProtocolHTTP}, "test") })
}

// The headline test: a real audit event recorded via recordEvent is forwarded
// to a running OTLP ingestor, with the same actor/action/target.
func TestSIEMForwardsAuditEvents(t *testing.T) {
	resetSIEM(t)
	srv, bodies, lastAuth := startOTLPReceiver(t)

	if err := setSIEMConfig(siemConfig{
		Enabled:   true,
		Protocol:  siemProtocolHTTP,
		Endpoint:  srv.URL,
		AuthToken: "secret-token",
	}, "test"); err != nil {
		t.Fatal(err)
	}

	// A normal mutation chokepoint records an audit event…
	if err := recordEvent("alice@example.com", auditDeviceApprove, "device-abc123"); err != nil {
		t.Fatal(err)
	}

	// …which must arrive at the ingestor (forwarding is async).
	select {
	case p := <-bodies:
		body, attrs := p.firstRecord(t)
		if !strings.Contains(body, auditDeviceApprove) || !strings.Contains(body, "alice@example.com") {
			t.Errorf("log body %q missing action/actor", body)
		}
		if attrs["event.name"] != auditDeviceApprove {
			t.Errorf("event.name = %q; want %q", attrs["event.name"], auditDeviceApprove)
		}
		if attrs["enduser.id"] != "alice@example.com" {
			t.Errorf("enduser.id = %q; want alice@example.com", attrs["enduser.id"])
		}
		if attrs["event.target"] != "device-abc123" {
			t.Errorf("event.target = %q; want device-abc123", attrs["event.target"])
		}
	case <-time.After(4 * time.Second):
		t.Fatal("no OTLP log received within timeout")
	}

	if got := lastAuth(); got != "Bearer secret-token" {
		t.Errorf("Authorization = %q; want Bearer secret-token", got)
	}
}

// When forwarding is disabled, nothing is sent.
func TestSIEMDisabledSendsNothing(t *testing.T) {
	resetSIEM(t)
	srv, bodies, _ := startOTLPReceiver(t)
	if err := setSIEMConfig(siemConfig{Enabled: false, Protocol: siemProtocolHTTP, Endpoint: srv.URL}, "test"); err != nil {
		t.Fatal(err)
	}
	if err := recordEvent("bob@example.com", auditDeviceRevoke, "device-x"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-bodies:
		t.Fatal("event was forwarded while SIEM was disabled")
	case <-time.After(600 * time.Millisecond):
		// expected: nothing arrives
	}
}

func TestOTLPEndpointURL(t *testing.T) {
	cases := []struct {
		name string
		cfg  siemConfig
		want string
	}{
		{"host only → https + /v1/logs", siemConfig{Endpoint: "collector.example.com"}, "https://collector.example.com/v1/logs"},
		{"scheme kept, path appended", siemConfig{Endpoint: "http://c.example.com"}, "http://c.example.com/v1/logs"},
		{"port override", siemConfig{Endpoint: "http://c.example.com", Port: 4318}, "http://c.example.com:4318/v1/logs"},
		{"explicit logs path kept", siemConfig{Endpoint: "https://c.example.com/otlp/v1/logs"}, "https://c.example.com/otlp/v1/logs"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := otlpEndpointURL(c.cfg)
			if err != nil {
				t.Fatalf("err: %v", err)
			}
			if got != c.want {
				t.Errorf("otlpEndpointURL = %q; want %q", got, c.want)
			}
		})
	}
	if _, err := otlpEndpointURL(siemConfig{Endpoint: ""}); err == nil {
		t.Error("empty endpoint should error")
	}
}

// The config API redacts the token and persists/keeps it correctly, and
// enabling against a live ingestor reports connected.
func TestHandleSIEM_SetGetRedactAndConnect(t *testing.T) {
	resetSIEM(t)
	srv, bodies, _ := startOTLPReceiver(t)

	// Enable with a token → synchronous test send → connected, token redacted.
	body := `{"enabled":true,"protocol":"` + siemProtocolHTTP + `","endpoint":"` + srv.URL + `","auth_token":"tok-123"}`
	w := httptest.NewRecorder()
	handleSIEMSet(w, httptest.NewRequest(http.MethodPost, "/bailey/api/admin/siem", strings.NewReader(body)), "admin@example.com")
	if w.Code != http.StatusOK {
		t.Fatalf("set = %d; body=%s", w.Code, w.Body.String())
	}
	var dto siemConfigDTO
	if err := json.Unmarshal(w.Body.Bytes(), &dto); err != nil {
		t.Fatal(err)
	}
	if !dto.Connected {
		t.Errorf("expected connected; last_error=%q", dto.LastError)
	}
	if !dto.HasAuthToken {
		t.Error("has_auth_token should be true")
	}
	if strings.Contains(w.Body.String(), "tok-123") {
		t.Error("auth token must never be echoed back")
	}
	// drain the test-send payload
	select {
	case <-bodies:
	case <-time.After(2 * time.Second):
		t.Fatal("connectivity test send never arrived")
	}

	// GET reflects the stored config without the token.
	wg := httptest.NewRecorder()
	handleSIEMGet(wg, httptest.NewRequest(http.MethodGet, "/bailey/api/admin/siem", nil))
	if wg.Code != http.StatusOK || strings.Contains(wg.Body.String(), "tok-123") {
		t.Fatalf("get leaked token or failed: %d %s", wg.Code, wg.Body.String())
	}

	// PATCH without auth_token (nil) keeps the stored token.
	w2 := httptest.NewRecorder()
	body2 := `{"enabled":true,"protocol":"` + siemProtocolHTTP + `","endpoint":"` + srv.URL + `"}`
	handleSIEMSet(w2, httptest.NewRequest(http.MethodPost, "/bailey/api/admin/siem", strings.NewReader(body2)), "admin@example.com")
	stored, _ := getSIEMConfig()
	if stored.AuthToken != "tok-123" {
		t.Errorf("token not preserved on PATCH without auth_token: %q", stored.AuthToken)
	}
	// drain
	select {
	case <-bodies:
	case <-time.After(2 * time.Second):
	}
}

// Enabling with an unreachable endpoint persists the config but reports
// disconnected with the error — never a silent "connected".
func TestHandleSIEM_EnableUnreachableReportsError(t *testing.T) {
	resetSIEM(t)
	// Port 1 is not listening.
	body := `{"enabled":true,"protocol":"` + siemProtocolHTTP + `","endpoint":"http://127.0.0.1:1"}`
	w := httptest.NewRecorder()
	handleSIEMSet(w, httptest.NewRequest(http.MethodPost, "/bailey/api/admin/siem", strings.NewReader(body)), "admin@example.com")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var dto siemConfigDTO
	_ = json.Unmarshal(w.Body.Bytes(), &dto)
	if dto.Connected {
		t.Error("must not report connected against an unreachable endpoint")
	}
	if dto.LastError == "" {
		t.Error("expected a last_error explaining the failure")
	}
}
