package daemon

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/bitswan-space/bitswan-workspaces/internal/config"
	"github.com/bitswan-space/bitswan-workspaces/internal/traefikapi"
)

// IngressTLSStatus is what `bitswan ingress tls` reports.
type IngressTLSStatus struct {
	Mode        string `json:"mode"`
	Description string `json:"description"`
	Domain      string `json:"domain,omitempty"`
	// DNSManagedByAOC says whether the AOC controls this domain's DNS. Reported
	// because it decides whether the default mode can issue anything at all, and
	// because it is otherwise invisible: nothing else on the server mentions it.
	DNSManagedByAOC bool `json:"dns_managed_by_aoc"`
	// InstalledCerts are the hostnames that carry an operator-installed
	// certificate. Reported in every mode, because their presence is what decides
	// whether a mode switch leaves anything behind.
	InstalledCerts []string `json:"installed_certs,omitempty"`
	// Certificates is the detail behind InstalledCerts: what each one is and when
	// it expires. Nothing renews these, so the expiry is the operationally
	// important field.
	Certificates []InstalledCertInfo `json:"certificates,omitempty"`
	// Warnings are conditions that are not errors but will surprise someone: a
	// manual mode with no certificate installed, or installed certificates that
	// now shadow an ACME mode.
	Warnings []string `json:"warnings,omitempty"`
}

// IngressTLSModeRequest sets the server's certificate mode.
type IngressTLSModeRequest struct {
	Mode string `json:"mode"`
}

// handleIngressTLS handles GET /ingress/tls (status) and POST /ingress/tls (set
// the mode, then reconcile the live route table onto it).
func (s *Server) handleIngressTLS(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, tlsStatus())
	case http.MethodPost:
		s.setTLSMode(w, r)
	default:
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleIngressTLSInstallCert handles POST /ingress/tls/install-cert.
func (s *Server) handleIngressTLSInstallCert(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req IngressTLSInstallRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.CertsDir == "" {
		writeJSONError(w, "certs_dir is required", http.StatusBadRequest)
		return
	}

	hostname, err := installTargetHostname(req)
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusBadRequest)
		return
	}

	info, notes, err := installCertificate(hostname, req.CertsDir)
	if err != nil {
		// A certificate that cannot serve traffic is a bad request, not a server
		// error: the operator supplied it and the message says what is wrong with it.
		writeJSONError(w, err.Error(), http.StatusBadRequest)
		return
	}

	status := tlsStatus()
	status.Warnings = append(notes, status.Warnings...)
	if currentTLSMode().usesACME() {
		status.Warnings = append(status.Warnings, fmt.Sprintf(
			"this server's TLS mode is %s, which renews from a CA; Traefik prefers a matching "+
				"installed certificate, so %s is now served from the file you just installed. "+
				"Switch to mode %s, or remove it with 'bitswan ingress tls remove-cert'",
			currentTLSMode(), info.Hostname, TLSModeManual))
	}
	writeJSON(w, status)
}

// handleIngressTLSRemoveCert handles POST /ingress/tls/remove-cert.
func (s *Server) handleIngressTLSRemoveCert(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSONError(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req IngressTLSRemoveCertRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Hostname == "" {
		writeJSONError(w, "hostname is required", http.StatusBadRequest)
		return
	}

	removed, err := traefikapi.RemoveTLSCert(req.Hostname)
	if err != nil {
		writeJSONError(w, "failed to remove the certificate: "+err.Error(),
			http.StatusInternalServerError)
		return
	}
	if !removed {
		writeJSONError(w, fmt.Sprintf("no installed certificate for %s", req.Hostname),
			http.StatusNotFound)
		return
	}
	// Delete the files too, so a later re-install cannot half-succeed against a
	// stale key and so the private key does not outlive its use.
	dir := filepath.Join(traefikCertsDirOnDaemon(), traefikapi.TLSCertDirSegment(req.Hostname))
	if err := os.RemoveAll(dir); err != nil {
		fmt.Printf("Warning: removed %s from the TLS store but could not delete %s: %v\n",
			req.Hostname, dir, err)
	}

	status := tlsStatus()
	if !currentTLSMode().usesACME() && len(status.InstalledCerts) == 0 {
		status.Warnings = append(status.Warnings, fmt.Sprintf(
			"that was the last installed certificate, and mode %s asks no CA for one: "+
				"every https hostname on this server will now fail its handshake",
			currentTLSMode()))
	}
	writeJSON(w, status)
}

// installTargetHostname turns the request into the single name to install under.
// A domain becomes one wildcard, which is the form that covers the hostnames the
// daemon registers for itself as well as every workspace host.
func installTargetHostname(req IngressTLSInstallRequest) (string, error) {
	domain := strings.TrimSpace(strings.ToLower(req.Domain))
	hostname := strings.TrimSpace(strings.ToLower(req.Hostname))
	switch {
	case domain != "" && hostname != "":
		return "", fmt.Errorf("pass either domain or hostname, not both")
	case domain != "":
		return "*." + strings.TrimPrefix(domain, "*."), nil
	case hostname != "":
		return hostname, nil
	default:
		return "", fmt.Errorf("domain or hostname is required")
	}
}

func (s *Server) setTLSMode(w http.ResponseWriter, r *http.Request) {
	var req IngressTLSModeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSONError(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	mode, err := ParseTLSMode(req.Mode)
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Refuse a mode that cannot issue for this server's domain. Storing it would
	// leave the server in a state where every certificate order fails, and the
	// operator would meet that as an ACME error minutes later rather than as an
	// answer to what they just asked for.
	if mode == TLSModeAOCDNS && getWildcardCertDomain() != "" && !aocManagesDNS() {
		writeJSONError(w, fmt.Sprintf(
			"mode %s issues through the AOC's zone, and the AOC does not manage DNS for %s — "+
				"no challenge for it can succeed. Use %s instead",
			mode, getWildcardCertDomain(), strings.Join(alternativeTLSModes(mode), " or ")),
			http.StatusBadRequest)
		return
	}

	previous := currentTLSMode()
	if err := config.NewAutomationServerConfig().SetTLSMode(string(mode)); err != nil {
		writeJSONError(w, "failed to persist TLS mode: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// Applying a mode is two jobs, and both have to happen or the server is left
	// half-switched: Traefik's STATIC config decides which resolvers exist at all
	// (so it must be rewritten and the container recreated), and the live route
	// table decides which routes ask for them. initTraefikIngress does the first
	// and calls the reconcile for the second.
	if _, err := initTraefikIngressFn(false); err != nil {
		// The mode is stored; the ingress did not come up on it. Say both, so the
		// operator knows a retry is what's needed rather than a re-set.
		writeJSONError(w, fmt.Sprintf(
			"TLS mode is now %s, but reconfiguring the ingress failed: %v — "+
				"re-run 'bitswan ingress init' once the cause is fixed", mode, err),
			http.StatusInternalServerError)
		return
	}

	status := tlsStatus()
	status.Warnings = append(status.Warnings, tlsModeSwitchNotes(previous, mode, status)...)
	writeJSON(w, status)
}

// tlsStatus reports the current certificate mode and anything about it that will
// surprise an operator.
func tlsStatus() IngressTLSStatus {
	mode := currentTLSMode()
	status := IngressTLSStatus{
		Mode:            string(mode),
		Description:     TLSModeDescription(mode),
		Domain:          getWildcardCertDomain(),
		DNSManagedByAOC: aocManagesDNS(),
		InstalledCerts:  traefikapi.InstalledCertHostnames(),
	}
	if status.Domain != "" && mode.usesACME() && !aocDNSUsable(mode) {
		status.Warnings = append(status.Warnings, fmt.Sprintf(
			"the AOC does not manage DNS for %s, so this mode cannot obtain a wildcard for it: "+
				"hosts fall back to per-host HTTP-01, which needs inbound :80 from the internet. "+
				"Use %s to issue here",
			status.Domain, strings.Join(alternativeTLSModes(mode), " or ")))
	}
	status.Certificates = installedCertDetails()
	for _, cert := range status.Certificates {
		switch {
		case cert.Problem != "":
			status.Warnings = append(status.Warnings,
				fmt.Sprintf("certificate for %s: %s", cert.Hostname, cert.Problem))
		case cert.DaysLeft < certExpiryWarnDays:
			status.Warnings = append(status.Warnings, fmt.Sprintf(
				"certificate for %s expires in %d days; nothing renews an installed certificate",
				cert.Hostname, cert.DaysLeft))
		}
	}
	if !mode.usesACME() && len(status.InstalledCerts) == 0 {
		status.Warnings = append(status.Warnings,
			"no certificates are installed, and this mode asks no CA for any: every https "+
				"hostname on this server will fail its TLS handshake until one is installed")
	}
	if mode.usesACME() && len(status.InstalledCerts) > 0 {
		status.Warnings = append(status.Warnings, fmt.Sprintf(
			"%d installed certificate(s) are still in the TLS store; Traefik serves a matching "+
				"installed certificate in preference to an ACME one, so these hostnames keep being "+
				"served the installed certificate even though this mode renews from a CA",
			len(status.InstalledCerts)))
	}
	return status
}

// tlsModeSwitchNotes explains what a switch did and did not do — the questions an
// operator asks immediately afterwards, answered before they have to ask.
func tlsModeSwitchNotes(from, to TLSMode, status IngressTLSStatus) []string {
	if from == to {
		return []string{fmt.Sprintf("mode was already %s; the ingress was reconciled anyway", to)}
	}
	notes := []string{fmt.Sprintf("switched from %s to %s", from, to)}
	if !to.usesACME() {
		notes = append(notes,
			"existing certificates issued by a CA are left in Traefik's ACME store but will not be "+
				"renewed; they keep working until they expire, which is the window you have to install "+
				"your own")
	}
	if status.Domain == "" {
		notes = append(notes,
			"this server has no domain assigned yet, so no routes were reconciled; the mode applies "+
				"to routes registered from now on")
	}
	return notes
}
