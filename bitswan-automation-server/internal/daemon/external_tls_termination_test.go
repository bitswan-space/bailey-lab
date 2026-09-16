package daemon

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// deadAddr is an address nothing listens on: the "proxy is not pointed here yet"
// and "our own ingress is down" states, which the check has to tell apart from a
// certificate it does not recognise.
const deadAddr = "127.0.0.1:1"

// writeTerminationConfig lays down a registered server's config in a temp HOME,
// with or without the external-termination declaration.
func writeTerminationConfig(t *testing.T, declared bool) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SUDO_USER", "")

	dir := filepath.Join(home, ".config", "bitswan")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	line := ""
	if declared {
		line = "external_tls_termination = true\n"
	}
	toml := fmt.Sprintf("tls_mode = %q\n%s[aoc]\n", TLSModeManual, line) +
		`aoc_url = "https://aoc.example.com"
automation_server_id = "test-server"
access_token = "test-token"
domain = "bitswan.customer.example"
dns_managed = false
`
	if err := os.WriteFile(filepath.Join(dir, "automation_server_config.toml"), []byte(toml), 0644); err != nil {
		t.Fatal(err)
	}
}

// tlsEndpoint starts a TLS listener holding its OWN freshly issued certificate
// and returns its host:port. Every call issues a different leaf, which is the
// whole point: it is how a test tells "compared the certificates" from "did not".
// (httptest.NewTLSServer cannot be used here — every instance of it serves the
// same built-in certificate, so two of them would compare equal.)
func tlsEndpoint(t *testing.T) string {
	t.Helper()
	certPEM, keyPEM := makeCert(t, []string{"bailey.bitswan.customer.example"},
		time.Now().Add(-time.Hour), time.Now().Add(24*time.Hour))
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	ln, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{pair}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				// The check only needs the handshake; nothing reads a response.
				_ = conn.(*tls.Conn).Handshake()
				_ = conn.Close()
			}()
		}
	}()
	return ln.Addr().String()
}

// The declaration must be OFF for every server that has not made it. It disarms
// half of an interception check, so an absent, empty or unreadable config is
// "no" — anything else would silently weaken servers whose operators never asked
// for it.
func TestExternalTLSTerminationIsOffUnlessDeclared(t *testing.T) {
	writeTerminationConfig(t, false)
	if externalTLSTermination() {
		t.Error("a config that does not declare it reported the declaration as set")
	}

	writeTerminationConfig(t, true)
	if !externalTLSTermination() {
		t.Error("a config that declares it reported the declaration as unset")
	}

	// No config at all (an unregistered server, or an unreadable file): still no.
	t.Setenv("HOME", t.TempDir())
	if externalTLSTermination() {
		t.Error("with no config at all the declaration must default to off")
	}
}

// The property the whole change turns on: with the declaration, the self-check
// stops comparing the served certificate against our own — and without it, the
// same mismatch is still the hard interception finding it has always been.
func TestSelfCheckComparesTheServedLeafOnlyWhenNothingElseTerminates(t *testing.T) {
	publicAddr := tlsEndpoint(t) // stands in for the operator's proxy
	localAddr := tlsEndpoint(t)  // stands in for this server's own Traefik

	writeTerminationConfig(t, false)
	t.Setenv("BITSWAN_RELAY_LOCAL_TARGET", localAddr)
	err := checkEndpointTLSOnce("bailey.bitswan.customer.example", publicAddr)
	if err == nil {
		t.Fatal("undeclared: a served certificate that is not ours must still fail the check")
	}
	if !strings.Contains(err.Error(), "MITM") && !strings.Contains(err.Error(), "interception") {
		t.Errorf("undeclared: the failure should name interception, got %v", err)
	}

	writeTerminationConfig(t, true)
	t.Setenv("BITSWAN_RELAY_LOCAL_TARGET", localAddr)
	if err := checkEndpointTLSOnce("bailey.bitswan.customer.example", publicAddr); err != nil {
		t.Errorf("declared: a certificate held by the operator's proxy is expected, not a failure: %v", err)
	}
}

// Narrowed, not switched off. An endpoint that does not answer is still a
// failure — that is the half of the check this topology can still support, and
// it is the one that catches a proxy pointed at the wrong backend.
func TestDeclaredTerminationStillRequiresTheEndpointToAnswer(t *testing.T) {
	localAddr := tlsEndpoint(t)

	writeTerminationConfig(t, true)
	t.Setenv("BITSWAN_RELAY_LOCAL_TARGET", localAddr)

	err := checkEndpointTLSOnce("bailey.bitswan.customer.example", deadAddr)
	if err == nil {
		t.Fatal("declared: an unreachable public endpoint must still fail")
	}
	if !strings.Contains(err.Error(), "did not answer") {
		t.Errorf("the failure should say the endpoint did not answer, got %v", err)
	}
}

// What register prints hangs off Trust, so the value has to say which of the
// three properties was actually established.
func TestVerifyExternallyTerminatedEndpointReportsWhatItProved(t *testing.T) {
	addr := tlsEndpoint(t)
	res := verifyExternallyTerminatedEndpoint(addr, "bailey.bitswan.customer.example")
	if !res.OK {
		t.Fatalf("a proxy that answers should verify: %+v", res)
	}
	if res.Trust != "terminated" {
		t.Errorf("Trust = %q, want %q — the caller must not read this as an end-to-end guarantee",
			res.Trust, "terminated")
	}

	res = verifyExternallyTerminatedEndpoint(deadAddr, "bailey.bitswan.customer.example")
	if res.OK {
		t.Error("an endpoint that does not answer must not verify")
	}
	if !res.Pending {
		t.Error("during registration a proxy not yet pointed here is a wait, not a hard failure")
	}
}

// Our own ingress being down is answered before anything is said about the proxy:
// it is the operator's actual problem in that state, and it is the one thing we
// can still establish when the public leaf belongs to somebody else.
func TestLocalIngressIsCheckedBeforeTheProxy(t *testing.T) {
	writeTerminationConfig(t, true)
	t.Setenv("BITSWAN_RELAY_LOCAL_TARGET", deadAddr)

	s := &Server{}
	res := s.verifyPublicEndpoint("bitswan.customer.example")
	if res.OK {
		t.Fatal("verified with no local ingress running")
	}
	if !res.Pending || !strings.Contains(res.Error, "local ingress") {
		t.Errorf("want a pending 'local ingress' stage, got %+v", res)
	}
}

// The declaration changes what a security check proves, so it has to be readable
// back off the server rather than remembered by whoever typed it.
func TestIngressTLSStatusReportsAndSetsTheDeclaration(t *testing.T) {
	writeTerminationConfig(t, false)
	s := &Server{}

	rec := httptest.NewRecorder()
	s.handleIngressTLSExternalTermination(rec, httptest.NewRequest(http.MethodPost,
		"/ingress/tls/external-termination", strings.NewReader(`{"enabled":true}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %q", rec.Code, rec.Body.String())
	}
	var status IngressTLSStatus
	if err := json.NewDecoder(rec.Body).Decode(&status); err != nil {
		t.Fatal(err)
	}
	if !status.ExternalTLSTermination {
		t.Error("the response should report the declaration it just recorded")
	}
	if !externalTLSTermination() {
		t.Error("the declaration was not persisted")
	}
	if !strings.Contains(strings.Join(status.Warnings, " "), "narrowed to reachability") {
		t.Errorf("the operator should be told what they gave up, got %v", status.Warnings)
	}

	// And it can be withdrawn — TLS termination moving back onto the server has to
	// re-arm the check, or the weakening is permanent by accident.
	rec = httptest.NewRecorder()
	s.handleIngressTLSExternalTermination(rec, httptest.NewRequest(http.MethodPost,
		"/ingress/tls/external-termination", strings.NewReader(`{"enabled":false}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body %q", rec.Code, rec.Body.String())
	}
	if externalTLSTermination() {
		t.Error("withdrawing the declaration did not take effect")
	}

	rec = httptest.NewRecorder()
	s.handleIngressTLS(rec, httptest.NewRequest(http.MethodGet, "/ingress/tls", nil))
	var plain IngressTLSStatus
	if err := json.NewDecoder(rec.Body).Decode(&plain); err != nil {
		t.Fatal(err)
	}
	if plain.ExternalTLSTermination {
		t.Error("status still reports a withdrawn declaration")
	}
}
