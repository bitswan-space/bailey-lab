package main

// End-to-end proof that the egress gateway actually enforces the allow-list
// (security finding F1). It stands up the real deployment shape — a proxy, a
// netns-owning gateway, and a worker that shares the gateway's netns with
// NET_ADMIN dropped — then asserts from inside the worker that:
//
//   * an allow-listed host (en.wikipedia.org) IS reachable through the gateway,
//   * a non-allow-listed host (example.com) is NOT,
//   * the cloud metadata endpoint (169.254.169.254) is NOT,
//   * the gateway installed a default-deny IPv6 (ip6tables) OUTPUT chain, so
//     egress cannot be bypassed over IPv6, and
//   * NON-HTTP ports go through the same allow-list: an allow-listed SMTP host
//     (smtp.gmail.com:587) IS reachable and answers with its banner, while a
//     non-allow-listed raw TCP destination (dns.google:53) is NOT — and that
//     block is written to the attempts log under the NAME the worker resolved,
//     with the port, which is what the dashboard's "Needs review" reads.
//
// It needs docker and outbound network access, so it is gated behind
// BITSWAN_EGRESS_INTEGRATION=1 and skips cleanly otherwise (keeping the default
// `go test ./...` unit run fast and hermetic).

import (
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

const egressTestImage = "bitswan/egress-gateway:fwtest"

func TestEgressGatewayEnforcesAllowListEndToEnd(t *testing.T) {
	if os.Getenv("BITSWAN_EGRESS_INTEGRATION") == "" {
		t.Skip("set BITSWAN_EGRESS_INTEGRATION=1 to run (needs docker + outbound network)")
	}
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker not available")
	}
	if err := exec.Command("docker", "info").Run(); err != nil {
		t.Skip("docker daemon not reachable")
	}
	buildEgressImage(t)

	const (
		net    = "fwtest-net"
		proxy  = "fwtest-proxy"
		owner  = "fwtest-owner"
		client = "fwtest-client"
	)
	rmAll := func() {
		exec.Command("docker", "rm", "-f", proxy, owner, client).Run()
		exec.Command("docker", "network", "rm", net).Run()
	}
	rmAll()
	if out, err := exec.Command("docker", "network", "create", net).CombinedOutput(); err != nil {
		t.Fatalf("docker network create: %v\n%s", err, out)
	}
	t.Cleanup(rmAll)

	// Proxy: the allow-list filter + DNS forwarder. en.wikipedia.org (HTTPS)
	// and smtp.gmail.com (a raw :587 port) are allowed; nothing else. It runs
	// exactly as the driver emits it: NET_ADMIN for its own REDIRECT funnel,
	// ip_forward for monitor-mode forwarding, and the attempts log on a volume
	// we can read back from the host.
	attemptsDir := t.TempDir()
	if err := os.Chmod(attemptsDir, 0o777); err != nil {
		t.Fatal(err)
	}
	mustDocker(t, "run", "-d", "--name", proxy, "--network", net,
		"--cap-add", "NET_ADMIN", "--sysctl", "net.ipv4.ip_forward=1",
		"-v", attemptsDir+":/firewall",
		"-e", "BITSWAN_FW_ROLE=proxy", "-e", "BITSWAN_FW_MODE=enforce",
		"-e", "BITSWAN_FW_ATTEMPTS=/firewall/test.attempts.jsonl",
		"-e", "BITSWAN_FW_ALLOW=en.wikipedia.org,smtp.gmail.com", egressTestImage)
	// Owner: holds the netns, routes it through the proxy, installs default-deny
	// (v4 and v6).
	mustDocker(t, "run", "-d", "--name", owner, "--network", net, "--cap-add", "NET_ADMIN",
		"-e", "BITSWAN_FW_ROLE=owner", "-e", "BITSWAN_FW_MODE=enforce",
		"-e", "BITSWAN_FW_PROXY="+proxy, egressTestImage)

	waitFor(t, "owner rules installed", func() bool {
		return exec.Command("docker", "exec", owner, "test", "-f", "/tmp/fw-ready").Run() == nil
	})
	waitFor(t, "proxy healthy", func() bool {
		out, _ := exec.Command("docker", "inspect", "-f", "{{.State.Health.Status}}", proxy).Output()
		return strings.TrimSpace(string(out)) == "healthy"
	})

	// IPv6 must be filtered too. If the kernel has no IPv6 stack the filter table
	// is genuinely absent (nothing to bypass); otherwise the OUTPUT chain must be
	// default-deny.
	if out, err := exec.Command("docker", "exec", owner, "ip6tables", "-S", "OUTPUT").CombinedOutput(); err == nil {
		if !strings.Contains(string(out), "-A OUTPUT -j DROP") {
			t.Fatalf("owner ip6tables OUTPUT is not default-deny — IPv6 egress fails open:\n%s", out)
		}
		t.Logf("IPv6 OUTPUT is default-deny:\n%s", strings.TrimSpace(string(out)))
	} else {
		t.Logf("no IPv6 stack in owner netns; nothing to filter (%v)", err)
	}

	// The worker shares the owner's netns with NET_ADMIN dropped — exactly how a
	// BP container runs. curlimages/curl gives us a client with curl.
	if out, err := exec.Command("docker", "run", "-d", "--name", client,
		"--network", "container:"+owner, "--cap-drop", "ALL",
		"--entrypoint", "sleep", "curlimages/curl:latest", "600").CombinedOutput(); err != nil {
		t.Skipf("could not start curl client (image pull failed?): %v\n%s", err, out)
	}

	// Allow-listed host: reachable through the firewall.
	if code, err := clientCurl(client, "https://en.wikipedia.org"); err != nil {
		t.Fatalf("allow-listed en.wikipedia.org is UNREACHABLE through the gateway (%v) — the firewall blocks permitted egress", err)
	} else {
		t.Logf("allowed en.wikipedia.org reachable (HTTP %s)", code)
	}
	// Non-allow-listed host: blocked.
	if code, err := clientCurl(client, "https://example.com"); err == nil {
		t.Fatalf("non-allow-listed example.com was REACHABLE (HTTP %s) — the egress firewall fails open", code)
	}
	// Cloud metadata endpoint: blocked (the live F1 PoC target).
	if code, err := clientCurl(client, "http://169.254.169.254/"); err == nil {
		t.Fatalf("cloud metadata endpoint 169.254.169.254 was REACHABLE (HTTP %s) — SSRF/credential-theft exposure", code)
	}

	// ---- any-port egress (the smtp.gmail.com:587 report) ----
	// A second worker in the same netns with busybox nc, for raw TCP.
	const rawClient = "fwtest-rawclient"
	exec.Command("docker", "rm", "-f", rawClient).Run()
	t.Cleanup(func() { exec.Command("docker", "rm", "-f", rawClient).Run() })
	if out, err := exec.Command("docker", "run", "-d", "--name", rawClient,
		"--network", "container:"+owner, "--cap-drop", "ALL",
		"alpine:3.20", "sleep", "600").CombinedOutput(); err != nil {
		t.Skipf("could not start alpine client (image pull failed?): %v\n%s", err, out)
	}
	// Allow-listed SMTP submission port: the connection goes through the proxy
	// (default route → REDIRECT → catch-all → DNS-cache name → allow-list) and
	// Gmail greets us with a 220 banner. QUIT makes the server close so nc
	// returns instead of idling until its timeout.
	out, err := exec.Command("docker", "exec", rawClient, "sh", "-c",
		"(sleep 2; echo QUIT) | nc -w 15 smtp.gmail.com 587").CombinedOutput()
	if err != nil || !strings.Contains(string(out), "220") {
		t.Fatalf("allow-listed smtp.gmail.com:587 is UNREACHABLE through the gateway (err=%v):\n%s", err, out)
	}
	t.Logf("allowed smtp.gmail.com:587 reachable, banner: %s", strings.TrimSpace(strings.SplitN(string(out), "\n", 2)[0]))
	// Non-allow-listed raw port: dns.google:53 over TCP. The proxy must close it
	// without connecting (no DNS answer comes back) AND record the attempt under
	// the resolved NAME with its port — that record is what makes the host
	// appear in the dashboard for approval instead of vanishing into a DROP.
	out, _ = exec.Command("docker", "exec", rawClient, "sh", "-c",
		// a minimal DNS query for "." over TCP; a real resolver would answer
		"printf '\\000\\021\\253\\315\\001\\000\\000\\001\\000\\000\\000\\000\\000\\000\\000\\000\\002\\000\\001' | nc -w 5 dns.google 53 | wc -c").CombinedOutput()
	if strings.TrimSpace(string(out)) != "0" {
		t.Fatalf("non-allow-listed dns.google:53 returned %s bytes — a raw TCP port bypassed the allow-list", strings.TrimSpace(string(out)))
	}
	var attempts string
	waitFor(t, "blocked dns.google:53 written to the attempts log", func() bool {
		b, _ := os.ReadFile(attemptsDir + "/test.attempts.jsonl")
		attempts = string(b)
		return strings.Contains(attempts, `"host":"dns.google"`) && strings.Contains(attempts, `"port":53`)
	})
	if strings.Contains(attempts, `"host":"smtp.gmail.com"`) {
		t.Fatalf("allow-listed smtp.gmail.com was logged as an attempt — it would wrongly show under Needs review:\n%s", attempts)
	}
	t.Logf("attempts log:\n%s", strings.TrimSpace(attempts))
}

// clientCurl runs curl inside the worker container and returns the HTTP status.
// err is non-nil when curl exits non-zero (connection blocked/refused).
func clientCurl(client, url string) (string, error) {
	out, err := exec.Command("docker", "exec", client,
		"curl", "-sS", "-m", "20", "-o", "/dev/null", "-w", "%{http_code}", url).Output()
	return strings.TrimSpace(string(out)), err
}

// buildEgressImage builds the gateway image from the repo Dockerfile so the test
// exercises the current entrypoint (incl. the IPv6 rules). Layer caching makes
// re-runs cheap.
func buildEgressImage(t *testing.T) {
	t.Helper()
	cmd := exec.Command("docker", "build", "-f", "cmd/egress-gateway/Dockerfile",
		"-t", egressTestImage, ".")
	cmd.Dir = "../.." // repo root, relative to this package dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("docker build egress image: %v\n%s", err, out)
	}
}

func mustDocker(t *testing.T, args ...string) {
	t.Helper()
	if out, err := exec.Command("docker", args...).CombinedOutput(); err != nil {
		t.Fatalf("docker %s: %v\n%s", strings.Join(args, " "), err, out)
	}
}

// waitFor polls cond until true, failing loudly after a hard deadline. A bounded
// readiness wait (not a blind sleep) — the deadline is the failure guard.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for: %s", what)
}
