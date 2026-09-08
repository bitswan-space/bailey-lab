package daemon

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/traefikapi"
)

// Installing certificates the operator supplies.
//
// The plumbing for this already existed per route (`--mkcert`, `--certs-dir`), but
// it was unusable as a deployment mode for three reasons, and all three are the
// kind that fail silently at TLS-handshake time rather than at install time:
//
//   - it installed per hostname, while the hostnames that matter are the ones the
//     DAEMON registers for itself (bailey., its --inner twin, the onboarding host,
//     the docs host) plus every workspace host — so an operator had to enumerate a
//     set they don't control;
//   - it copied whatever files it found and then registered two fixed names, so a
//     directory holding `fullchain.pem`/`privkey.pem` (what every ACME client on
//     earth produces) installed successfully and served nothing;
//   - it checked nothing: not that the key matched the certificate, not that the
//     certificate covered the hostname, not that it was still in date.
//
// So: install once as a wildcard for the whole domain, identify the files by their
// PEM content instead of their names, and refuse anything that cannot work.

// certExpiryWarnDays is when an installed certificate starts being reported as a
// problem. Nothing renews these automatically, so the warning is the only thing
// standing between the operator and an outage.
const certExpiryWarnDays = 30

// InstalledCertInfo describes one installed certificate.
type InstalledCertInfo struct {
	// Hostname is the name it was installed for ("*.acme.example.com").
	Hostname string `json:"hostname"`
	Subject  string `json:"subject,omitempty"`
	Issuer   string `json:"issuer,omitempty"`
	NotAfter string `json:"not_after,omitempty"`
	// DaysLeft is negative once expired.
	DaysLeft int      `json:"days_left"`
	DNSNames []string `json:"dns_names,omitempty"`
	// Problem is set when the certificate cannot serve traffic (unreadable,
	// expired). Empty means it is usable.
	Problem string `json:"problem,omitempty"`
}

// IngressTLSInstallRequest installs an operator-supplied certificate.
type IngressTLSInstallRequest struct {
	// Domain installs one wildcard covering *.<domain> — the form that covers
	// every hostname this server serves, including the ones the daemon registers
	// for itself.
	Domain string `json:"domain,omitempty"`
	// Hostname installs for exactly one host (or an explicit "*.x" wildcard).
	Hostname string `json:"hostname,omitempty"`
	// CertsDir holds the certificate and its key, in any file naming.
	CertsDir string `json:"certs_dir"`
}

// IngressTLSRemoveCertRequest removes an installed certificate.
type IngressTLSRemoveCertRequest struct {
	Hostname string `json:"hostname"`
}

// certAndKeyFromDir finds the certificate chain and private key in a directory by
// looking at what the files CONTAIN, not what they are called.
//
// Every tool names these differently — fullchain.pem/privkey.pem (certbot,
// lego), tls.crt/tls.key (Kubernetes), cert.pem/key.pem, or one combined file —
// and the previous behaviour was to copy the directory verbatim and then look for
// two hard-coded names, which turned the most common naming in the world into a
// successful install that served nothing.
func certAndKeyFromDir(dir string) (certPEM, keyPEM []byte, err error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, nil, fmt.Errorf("cannot read %s: %w", dir, err)
	}

	bestCertBlocks := 0
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		data, readErr := os.ReadFile(filepath.Join(dir, entry.Name()))
		if readErr != nil {
			continue
		}
		certs, key := splitPEM(data)
		// Prefer the file with the most certificates: that is the full chain
		// rather than the bare leaf, and Traefik should serve the chain.
		if n := countPEMBlocks(certs, "CERTIFICATE"); n > bestCertBlocks {
			certPEM, bestCertBlocks = certs, n
		}
		if key != nil && keyPEM == nil {
			keyPEM = key
		}
	}

	if certPEM == nil {
		return nil, nil, fmt.Errorf("no PEM certificate found in %s "+
			"(looked at the contents of every file, not their names)", dir)
	}
	if keyPEM == nil {
		return nil, nil, fmt.Errorf("no PEM private key found in %s", dir)
	}
	return certPEM, keyPEM, nil
}

// splitPEM separates the CERTIFICATE blocks from the private-key block in one
// file's contents. A combined file (key and chain together) yields both.
func splitPEM(data []byte) (certPEM, keyPEM []byte) {
	rest := data
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		switch {
		case block.Type == "CERTIFICATE":
			certPEM = append(certPEM, pem.EncodeToMemory(block)...)
		case strings.HasSuffix(block.Type, "PRIVATE KEY"):
			if keyPEM == nil {
				keyPEM = pem.EncodeToMemory(block)
			}
		}
	}
	return certPEM, keyPEM
}

func countPEMBlocks(data []byte, blockType string) int {
	n := 0
	rest := data
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			return n
		}
		if block.Type == blockType {
			n++
		}
	}
}

// validateCertForHostname checks the things that otherwise fail at handshake time,
// invisibly: that the key belongs to the certificate, that the certificate covers
// the hostname it is being installed for, and that it is in date.
func validateCertForHostname(certPEM, keyPEM []byte, hostname string) (*x509.Certificate, error) {
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("the certificate and key do not form a usable pair: %w", err)
	}
	if len(pair.Certificate) == 0 {
		return nil, fmt.Errorf("the certificate file contains no certificate")
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return nil, fmt.Errorf("cannot parse the leaf certificate: %w", err)
	}

	// VerifyHostname applies the wildcard rules a client would: a "*.example.com"
	// certificate does NOT cover "example.com", and does not cover two labels deep.
	probe := hostname
	if strings.HasPrefix(hostname, "*.") {
		// Check the wildcard covers a child name, which is what it will serve.
		probe = "probe." + strings.TrimPrefix(hostname, "*.")
	}
	if err := leaf.VerifyHostname(probe); err != nil {
		return nil, fmt.Errorf("this certificate does not cover %s (it is valid for %s)",
			hostname, strings.Join(leaf.DNSNames, ", "))
	}

	now := time.Now()
	if now.After(leaf.NotAfter) {
		return nil, fmt.Errorf("this certificate expired on %s", leaf.NotAfter.Format(time.RFC3339))
	}
	if now.Before(leaf.NotBefore) {
		return nil, fmt.Errorf("this certificate is not valid until %s",
			leaf.NotBefore.Format(time.RFC3339))
	}
	return leaf, nil
}

// installCertificate writes the certificate into Traefik's TLS store under
// hostname and registers it. Returns what was installed, plus any advisory notes.
func installCertificate(hostname, certsDir string) (InstalledCertInfo, []string, error) {
	certPEM, keyPEM, err := certAndKeyFromDir(certsDir)
	if err != nil {
		return InstalledCertInfo{}, nil, err
	}
	leaf, err := validateCertForHostname(certPEM, keyPEM, hostname)
	if err != nil {
		return InstalledCertInfo{}, nil, err
	}

	// Stage the canonical filenames InstallTLSCerts registers, so the install
	// works whatever the source directory called them.
	staging, err := os.MkdirTemp("", "bitswan-cert-*")
	if err != nil {
		return InstalledCertInfo{}, nil, fmt.Errorf("cannot stage the certificate: %w", err)
	}
	defer os.RemoveAll(staging)
	if err := os.WriteFile(filepath.Join(staging, "full-chain.pem"), certPEM, 0600); err != nil {
		return InstalledCertInfo{}, nil, err
	}
	if err := os.WriteFile(filepath.Join(staging, "private-key.pem"), keyPEM, 0600); err != nil {
		return InstalledCertInfo{}, nil, err
	}

	if err := traefikapi.InstallTLSCerts(hostname, false, staging); err != nil {
		return InstalledCertInfo{}, nil, fmt.Errorf("failed to install the certificate: %w", err)
	}

	info := certInfo(hostname, leaf)
	var notes []string
	if info.DaysLeft < certExpiryWarnDays {
		notes = append(notes, fmt.Sprintf(
			"this certificate expires in %d days and nothing renews it automatically in this mode",
			info.DaysLeft))
	}
	if strings.HasPrefix(hostname, "*.") {
		apex := strings.TrimPrefix(hostname, "*.")
		if leaf.VerifyHostname(apex) != nil {
			notes = append(notes, fmt.Sprintf(
				"the certificate does not cover the bare domain %s (a wildcard does not, on its own); "+
					"any route on the domain itself will not be served", apex))
		}
	}
	return info, notes, nil
}

func certInfo(hostname string, leaf *x509.Certificate) InstalledCertInfo {
	return InstalledCertInfo{
		Hostname: hostname,
		Subject:  leaf.Subject.CommonName,
		Issuer:   leaf.Issuer.CommonName,
		NotAfter: leaf.NotAfter.Format(time.RFC3339),
		DaysLeft: int(time.Until(leaf.NotAfter).Hours() / 24),
		DNSNames: leaf.DNSNames,
	}
}

// traefikCertsDirOnDaemon is where the daemon sees the certificate files Traefik
// serves. Traefik has the same volume mounted at /tls, so a registered
// "/tls/<segment>/full-chain.pem" is this directory plus <segment>.
func traefikCertsDirOnDaemon() string {
	return filepath.Join(os.Getenv("HOME"), ".config", "bitswan", "traefik", "certs")
}

// installedCertDetails parses every certificate registered in the TLS store, so
// the status surface can report what is installed, when it expires, and whether it
// is already unusable. Expiry is the whole point: nothing renews these.
func installedCertDetails() []InstalledCertInfo {
	entries := traefikapi.InstalledCertEntries()
	out := make([]InstalledCertInfo, 0, len(entries))
	for _, entry := range entries {
		path := filepath.Join(traefikCertsDirOnDaemon(), entry.HostSegment, filepath.Base(entry.CertFile))
		info := InstalledCertInfo{Hostname: entry.HostSegment}
		data, err := os.ReadFile(path)
		if err != nil {
			info.Problem = "certificate file is missing or unreadable: " + err.Error()
			out = append(out, info)
			continue
		}
		block, _ := pem.Decode(data)
		if block == nil {
			info.Problem = "certificate file is not PEM"
			out = append(out, info)
			continue
		}
		leaf, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			info.Problem = "certificate cannot be parsed: " + err.Error()
			out = append(out, info)
			continue
		}
		parsed := certInfo(entry.HostSegment, leaf)
		if parsed.DaysLeft < 0 {
			parsed.Problem = fmt.Sprintf("EXPIRED %d days ago", -parsed.DaysLeft)
		}
		out = append(out, parsed)
	}
	return out
}

// warnAboutInstalledCertExpiry logs expiring or expired installed certificates.
// Called from the ingress init, which runs on every daemon boot: in a mode with no
// automatic renewal, a log line at boot is the earliest anyone finds out.
func warnAboutInstalledCertExpiry() {
	for _, info := range installedCertDetails() {
		switch {
		case info.Problem != "":
			fmt.Printf("Warning: installed certificate for %s: %s\n", info.Hostname, info.Problem)
		case info.DaysLeft < certExpiryWarnDays:
			fmt.Printf("Warning: installed certificate for %s expires in %d days (%s) and nothing "+
				"renews it in this TLS mode — install a replacement with "+
				"'bitswan ingress tls install-cert'\n", info.Hostname, info.DaysLeft, info.NotAfter)
		}
	}
}

// resolveHostPath maps a path the CALLER named onto one the daemon can read.
//
// The CLI runs on the host and the daemon runs in a container with the host root
// bind-mounted at /host, so `--certs-dir /root/certs` means /host/root/certs from
// in here. Without this, every host path an operator supplies fails as "cannot
// read" and looks like a typo. Tries the path as given first, so a path that is
// already container-local (or a test's temp dir) still works.
func resolveHostPath(p string) (string, error) {
	if p == "" {
		return "", fmt.Errorf("no path given")
	}
	if _, err := os.Stat(p); err == nil {
		return p, nil
	}
	if !filepath.IsAbs(p) {
		return "", fmt.Errorf("%s does not exist (relative paths are resolved against the daemon, "+
			"not your shell — pass an absolute path)", p)
	}
	viaHost := filepath.Join("/host", p)
	if _, err := os.Stat(viaHost); err == nil {
		return viaHost, nil
	}
	return "", fmt.Errorf("%s does not exist (also looked for it at %s, where the daemon sees "+
		"the host filesystem)", p, viaHost)
}
