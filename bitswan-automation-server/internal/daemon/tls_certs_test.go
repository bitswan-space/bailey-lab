package daemon

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/traefikapi"
)

// internalCA is a throwaway CA standing in for a customer's own PKI — the case
// manual mode exists for. Built once per test binary so leaves share an issuer.
var internalCA = struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pem  []byte
}{}

func caFor(t *testing.T) (*x509.Certificate, *ecdsa.PrivateKey, []byte) {
	t.Helper()
	if internalCA.cert != nil {
		return internalCA.cert, internalCA.key, internalCA.pem
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Acme Internal CA"},
		NotBefore:             time.Now().Add(-24 * time.Hour),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	internalCA.cert, internalCA.key = cert, key
	internalCA.pem = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	return internalCA.cert, internalCA.key, internalCA.pem
}

// makeCert issues a leaf for the given names from the throwaway internal CA.
func makeCert(t *testing.T, names []string, notBefore, notAfter time.Time) (certPEM, keyPEM []byte) {
	t.Helper()
	caCert, caKey, _ := caFor(t)
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: names[0]},
		DNSNames:     names,
		NotBefore:    notBefore,
		NotAfter:     notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, caCert, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	return certPEM, keyPEM
}

func writeCertDir(t *testing.T, files map[string][]byte) string {
	t.Helper()
	dir := t.TempDir()
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(dir, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// TestCertAndKeyFoundByContentNotFilename: every issuer names these files
// differently, and the old behaviour copied the directory verbatim and then looked
// for two hard-coded names — so the most common naming in the world
// (fullchain.pem/privkey.pem, what certbot and lego write) installed successfully
// and served nothing.
func TestCertAndKeyFoundByContentNotFilename(t *testing.T) {
	certPEM, keyPEM := makeCert(t, []string{"*.acme-prod.bswn.io"},
		time.Now().Add(-time.Hour), time.Now().Add(365*24*time.Hour))

	for _, tc := range []struct {
		name  string
		files map[string][]byte
	}{
		{"certbot/lego", map[string][]byte{"fullchain.pem": certPEM, "privkey.pem": keyPEM}},
		{"kubernetes", map[string][]byte{"tls.crt": certPEM, "tls.key": keyPEM}},
		{"openssl-ish", map[string][]byte{"cert.pem": certPEM, "key.pem": keyPEM}},
		{"our own names", map[string][]byte{"full-chain.pem": certPEM, "private-key.pem": keyPEM}},
		{"combined single file", map[string][]byte{"bundle.pem": append(append([]byte{}, keyPEM...), certPEM...)}},
		{"no extension", map[string][]byte{"certificate": certPEM, "privatekey": keyPEM}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gotCert, gotKey, err := certAndKeyFromDir(writeCertDir(t, tc.files))
			if err != nil {
				t.Fatalf("certAndKeyFromDir: %v", err)
			}
			if string(gotCert) != string(certPEM) {
				t.Error("certificate not recovered")
			}
			if string(gotKey) != string(keyPEM) {
				t.Error("key not recovered")
			}
		})
	}

	// A directory with no key, and one with no certificate, are both errors — not
	// a half-install that fails later at handshake time.
	if _, _, err := certAndKeyFromDir(writeCertDir(t, map[string][]byte{"c.pem": certPEM})); err == nil {
		t.Error("a directory with no private key should be rejected")
	}
	if _, _, err := certAndKeyFromDir(writeCertDir(t, map[string][]byte{"k.pem": keyPEM})); err == nil {
		t.Error("a directory with no certificate should be rejected")
	}
	if _, _, err := certAndKeyFromDir(writeCertDir(t, map[string][]byte{"readme.txt": []byte("hello")})); err == nil {
		t.Error("a directory with no PEM at all should be rejected")
	}
}

// The full chain is preferred over a bare leaf: Traefik should serve the chain, and
// a directory usually contains both.
func TestCertAndKeyPrefersTheFullChain(t *testing.T) {
	leafPEM, keyPEM := makeCert(t, []string{"*.acme-prod.bswn.io"},
		time.Now().Add(-time.Hour), time.Now().Add(24*time.Hour))
	_, _, caPEM := caFor(t)
	chain := append(append([]byte{}, leafPEM...), caPEM...)

	gotCert, _, err := certAndKeyFromDir(writeCertDir(t, map[string][]byte{
		"cert.pem":      leafPEM,
		"fullchain.pem": chain,
		"privkey.pem":   keyPEM,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if countPEMBlocks(gotCert, "CERTIFICATE") != 2 {
		t.Errorf("picked the bare leaf over the full chain (%d blocks)",
			countPEMBlocks(gotCert, "CERTIFICATE"))
	}
}

// TestValidateCertForHostname covers the three failures that otherwise show up
// only as a browser error much later: a key that isn't the certificate's, a
// certificate that doesn't cover the name, and one that is out of date.
func TestValidateCertForHostname(t *testing.T) {
	now := time.Now()
	valid, validKey := makeCert(t, []string{"*.acme-prod.bswn.io"}, now.Add(-time.Hour), now.Add(90*24*time.Hour))
	_, otherKey := makeCert(t, []string{"*.acme-prod.bswn.io"}, now.Add(-time.Hour), now.Add(90*24*time.Hour))
	expired, expiredKey := makeCert(t, []string{"*.acme-prod.bswn.io"}, now.Add(-72*time.Hour), now.Add(-time.Hour))
	future, futureKey := makeCert(t, []string{"*.acme-prod.bswn.io"}, now.Add(24*time.Hour), now.Add(90*24*time.Hour))
	wrongName, wrongNameKey := makeCert(t, []string{"*.other.example.com"}, now.Add(-time.Hour), now.Add(90*24*time.Hour))

	if _, err := validateCertForHostname(valid, validKey, "*.acme-prod.bswn.io"); err != nil {
		t.Errorf("a valid wildcard was rejected: %v", err)
	}
	// The same certificate installed under one of its child names is fine too.
	if _, err := validateCertForHostname(valid, validKey, "bailey.acme-prod.bswn.io"); err != nil {
		t.Errorf("a wildcard should cover a child name: %v", err)
	}
	// A wildcard does NOT cover the bare domain, and must not claim to.
	if _, err := validateCertForHostname(valid, validKey, "acme-prod.bswn.io"); err == nil {
		t.Error("a *.x certificate must not be accepted for x itself")
	}
	// Nor two labels deep.
	if _, err := validateCertForHostname(valid, validKey, "deep.app.acme-prod.bswn.io"); err == nil {
		t.Error("a *.x certificate must not be accepted two labels deep")
	}

	for _, tc := range []struct {
		name string
		cert []byte
		key  []byte
		host string
	}{
		{"mismatched key", valid, otherKey, "*.acme-prod.bswn.io"},
		{"expired", expired, expiredKey, "*.acme-prod.bswn.io"},
		{"not yet valid", future, futureKey, "*.acme-prod.bswn.io"},
		{"wrong name", wrongName, wrongNameKey, "*.acme-prod.bswn.io"},
		{"garbage", []byte("not a pem"), validKey, "*.acme-prod.bswn.io"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := validateCertForHostname(tc.cert, tc.key, tc.host); err == nil {
				t.Errorf("%s should have been rejected", tc.name)
			}
		})
	}
}

// TestInstallCertificateEndToEnd: install a wildcard, confirm Traefik is told
// about it and the files landed under the canonical names it expects, confirm the
// status surface can parse it back, then remove it.
func TestInstallCertificateEndToEnd(t *testing.T) {
	writeTLSModeConfig(t, string(TLSModeManual))
	const wildcard = "*.acme-prod.bswn.io"
	certPEM, keyPEM := makeCert(t, []string{wildcard}, time.Now().Add(-time.Hour),
		time.Now().Add(200*24*time.Hour))
	dir := writeCertDir(t, map[string][]byte{"fullchain.pem": certPEM, "privkey.pem": keyPEM})

	info, notes, err := installCertificate(wildcard, dir)
	if err != nil {
		t.Fatalf("installCertificate: %v", err)
	}
	if info.Issuer != "Acme Internal CA" {
		t.Errorf("issuer = %q", info.Issuer)
	}
	if info.DaysLeft < 190 {
		t.Errorf("DaysLeft = %d, want ~200", info.DaysLeft)
	}
	// A wildcard that omits the apex is a real gap worth naming: any route on the
	// bare domain will not be served.
	if len(notes) == 0 || !strings.Contains(strings.Join(notes, " "), "bare domain") {
		t.Errorf("expected a note about the apex not being covered, got %v", notes)
	}

	// The files must be where Traefik was told to look: /tls/<segment>/full-chain.pem
	// maps to <certs-dir>/<segment>/full-chain.pem on this side of the volume.
	certPath := filepath.Join(traefikCertsDirOnDaemon(),
		traefikapi.TLSCertDirSegment(wildcard), "full-chain.pem")
	if _, err := os.Stat(certPath); err != nil {
		t.Fatalf("certificate is not where Traefik was told to look (%s): %v", certPath, err)
	}
	details := installedCertDetails()
	if len(details) != 1 {
		t.Fatalf("installedCertDetails() = %v, want exactly one entry", details)
	}
	if details[0].Problem != "" {
		t.Errorf("installed certificate reports a problem: %s", details[0].Problem)
	}
	if details[0].Issuer != "Acme Internal CA" {
		t.Errorf("parsed issuer = %q", details[0].Issuer)
	}

	// Re-installing a replacement is the renewal path, and must overwrite rather
	// than accumulate entries.
	newCert, newKey := makeCert(t, []string{wildcard}, time.Now().Add(-time.Hour),
		time.Now().Add(400*24*time.Hour))
	if _, _, err := installCertificate(wildcard,
		writeCertDir(t, map[string][]byte{"tls.crt": newCert, "tls.key": newKey})); err != nil {
		t.Fatalf("re-install: %v", err)
	}
	details = installedCertDetails()
	if len(details) != 1 {
		t.Fatalf("re-install produced %d entries, want 1", len(details))
	}
	if details[0].DaysLeft < 390 {
		t.Errorf("re-install did not replace the certificate (DaysLeft = %d)", details[0].DaysLeft)
	}
}

// An expired certificate that is already installed must be reported as a problem,
// not silently listed: nothing renews these, so this is the only warning there is.
func TestInstalledCertDetailsFlagsExpiry(t *testing.T) {
	writeTLSModeConfig(t, string(TLSModeManual))
	const host = "bailey.acme-prod.bswn.io"

	// Install a valid one, then overwrite the file on disk with an expired
	// certificate — which is what the passage of time does.
	certPEM, keyPEM := makeCert(t, []string{host}, time.Now().Add(-time.Hour), time.Now().Add(48*time.Hour))
	if _, _, err := installCertificate(host,
		writeCertDir(t, map[string][]byte{"c.pem": certPEM, "k.pem": keyPEM})); err != nil {
		t.Fatal(err)
	}
	details := installedCertDetails()
	if len(details) != 1 || details[0].DaysLeft > 2 {
		t.Fatalf("details = %+v", details)
	}

	expiredPEM, _ := makeCert(t, []string{host}, time.Now().Add(-72*time.Hour), time.Now().Add(-24*time.Hour))
	path := filepath.Join(traefikCertsDirOnDaemon(), traefikapi.TLSCertDirSegment(host), "full-chain.pem")
	if err := os.WriteFile(path, expiredPEM, 0600); err != nil {
		t.Fatal(err)
	}
	details = installedCertDetails()
	if len(details) != 1 {
		t.Fatalf("details = %+v", details)
	}
	if !strings.Contains(details[0].Problem, "EXPIRED") {
		t.Errorf("expired certificate not flagged: %+v", details[0])
	}
}

// TestRemoveCertClearsTheShadow: an installed certificate SHADOWS an ACME one —
// Traefik prefers a matching certificate from its file store — so a server moving
// back onto a CA has to be able to get rid of it, and the entry AND the files have
// to go or a later re-install works against a stale key.
func TestRemoveCertClearsTheShadow(t *testing.T) {
	writeTLSModeConfig(t, string(TLSModeManual))
	const wildcard = "*.acme-prod.bswn.io"
	certPEM, keyPEM := makeCert(t, []string{wildcard}, time.Now().Add(-time.Hour),
		time.Now().Add(90*24*time.Hour))
	if _, _, err := installCertificate(wildcard,
		writeCertDir(t, map[string][]byte{"c.pem": certPEM, "k.pem": keyPEM})); err != nil {
		t.Fatal(err)
	}

	s := &Server{}
	rec := httptest.NewRecorder()
	s.handleIngressTLSRemoveCert(rec, httptest.NewRequest(http.MethodPost, "/ingress/tls/remove-cert",
		strings.NewReader(`{"hostname":"*.acme-prod.bswn.io"}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}

	if got := installedCertDetails(); len(got) != 0 {
		t.Errorf("certificate still registered after removal: %+v", got)
	}
	dir := filepath.Join(traefikCertsDirOnDaemon(), traefikapi.TLSCertDirSegment(wildcard))
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("private key survived removal at %s", dir)
	}
	// Removing the last certificate in a mode that asks no CA for one leaves the
	// server unable to serve https at all. Say so.
	var status IngressTLSStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(status.Warnings, " "), "fail its handshake") {
		t.Errorf("expected a warning that nothing can be served now, got %v", status.Warnings)
	}

	// Removing something that isn't installed is a 404, not a silent success.
	rec = httptest.NewRecorder()
	s.handleIngressTLSRemoveCert(rec, httptest.NewRequest(http.MethodPost, "/ingress/tls/remove-cert",
		strings.NewReader(`{"hostname":"nope.acme-prod.bswn.io"}`)))
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

// Installing a certificate on a server that renews from a CA is allowed but is
// almost always a mistake — the installed one wins from then on. Say that at the
// moment it happens, not when someone notices an expired page in three months.
func TestInstallCertWarnsWhenTheModeRenewsFromACA(t *testing.T) {
	writeTLSModeConfig(t, "") // aoc-dns
	const wildcard = "*.acme-prod.bswn.io"
	certPEM, keyPEM := makeCert(t, []string{wildcard}, time.Now().Add(-time.Hour),
		time.Now().Add(90*24*time.Hour))
	dir := writeCertDir(t, map[string][]byte{"c.pem": certPEM, "k.pem": keyPEM})

	body, _ := json.Marshal(IngressTLSInstallRequest{Domain: "acme-prod.bswn.io", CertsDir: dir})
	s := &Server{}
	rec := httptest.NewRecorder()
	s.handleIngressTLSInstallCert(rec, httptest.NewRequest(http.MethodPost,
		"/ingress/tls/install-cert", strings.NewReader(string(body))))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	var status IngressTLSStatus
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(status.Warnings, " "), "prefers a matching") {
		t.Errorf("expected a shadowing warning, got %v", status.Warnings)
	}
}

// A certificate the operator supplied that cannot work is a BAD REQUEST with the
// reason, not a 500 and not a success that fails at handshake time.
func TestInstallCertRejectsUnusableInput(t *testing.T) {
	writeTLSModeConfig(t, string(TLSModeManual))
	s := &Server{}

	wrong, wrongKey := makeCert(t, []string{"*.other.example.com"}, time.Now().Add(-time.Hour),
		time.Now().Add(90*24*time.Hour))
	dir := writeCertDir(t, map[string][]byte{"c.pem": wrong, "k.pem": wrongKey})

	body, _ := json.Marshal(IngressTLSInstallRequest{Domain: "acme-prod.bswn.io", CertsDir: dir})
	rec := httptest.NewRecorder()
	s.handleIngressTLSInstallCert(rec, httptest.NewRequest(http.MethodPost,
		"/ingress/tls/install-cert", strings.NewReader(string(body))))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body %q)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "does not cover") {
		t.Errorf("the error should name the mismatch: %q", rec.Body.String())
	}
	if got := installedCertDetails(); len(got) != 0 {
		t.Errorf("a rejected certificate was installed anyway: %+v", got)
	}

	// Both selectors, or neither, is a usage error.
	for _, payload := range []string{
		`{"certs_dir":"/tmp","domain":"a.example.com","hostname":"b.example.com"}`,
		`{"certs_dir":"/tmp"}`,
		`{"domain":"a.example.com"}`,
	} {
		rec = httptest.NewRecorder()
		s.handleIngressTLSInstallCert(rec, httptest.NewRequest(http.MethodPost,
			"/ingress/tls/install-cert", strings.NewReader(payload)))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("payload %s: status = %d, want 400", payload, rec.Code)
		}
	}
}

func TestInstallTargetHostname(t *testing.T) {
	for _, tc := range []struct {
		req  IngressTLSInstallRequest
		want string
	}{
		{IngressTLSInstallRequest{Domain: "acme-prod.bswn.io"}, "*.acme-prod.bswn.io"},
		{IngressTLSInstallRequest{Domain: "*.acme-prod.bswn.io"}, "*.acme-prod.bswn.io"},
		{IngressTLSInstallRequest{Domain: "ACME-PROD.bswn.io"}, "*.acme-prod.bswn.io"},
		{IngressTLSInstallRequest{Hostname: "bailey.acme-prod.bswn.io"}, "bailey.acme-prod.bswn.io"},
	} {
		got, err := installTargetHostname(tc.req)
		if err != nil {
			t.Errorf("%+v: %v", tc.req, err)
			continue
		}
		if got != tc.want {
			t.Errorf("%+v = %q, want %q", tc.req, got, tc.want)
		}
	}
}
