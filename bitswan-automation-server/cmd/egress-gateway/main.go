// Command egress-gateway is the Bitswan per-BP transparent egress firewall.
//
// BP containers share this container's network namespace
// (network_mode: service:<gateway>) and have NET_ADMIN/NET_RAW dropped, so the
// iptables rules installed here (by entrypoint.sh, exempting only this proxy's
// uid) intercept ALL of their outbound TCP :80/:443 and redirect it to this
// proxy — and root inside a BP container cannot alter the rules. The proxy
// extracts the destination host (TLS SNI for :443, HTTP Host for :80), checks
// the allow-list, and in ENFORCE mode blocks anything unlisted; in MONITOR mode
// it allows everything but logs unlisted hosts. Blocked/observed hosts are
// appended to the attempts log for the dashboard's "Needs review" queue.
package main

import (
	"bufio"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

func main() {
	mode := os.Getenv("BITSWAN_FW_MODE") // "monitor" | "enforce"
	if mode != "enforce" {
		mode = "monitor"
	}
	allow := NewAllowList(splitCSV(os.Getenv("BITSWAN_FW_ALLOW")))
	gw := &gateway{
		mode:    mode,
		allow:   allow,
		attempts: os.Getenv("BITSWAN_FW_ATTEMPTS"), // JSONL path on a shared volume
	}
	log.Printf("egress-gateway: mode=%s allow=%q", mode, os.Getenv("BITSWAN_FW_ALLOW"))

	go gw.serve(":8443", gw.handleTLS)
	gw.serve(":8080", gw.handleHTTP)
}

func splitCSV(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

type gateway struct {
	mode     string
	allow    *AllowList
	attempts string
	mu       sync.Mutex
}

func (g *gateway) serve(addr string, handle func(net.Conn)) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("listen %s: %v", addr, err)
	}
	log.Printf("listening on %s", addr)
	for {
		c, err := ln.Accept()
		if err != nil {
			continue
		}
		go handle(c)
	}
}

// decide applies the allow-list + mode. Returns whether to proceed and logs the
// attempt when the host is unlisted (blocked in enforce, observed in monitor).
func (g *gateway) decide(host, proto string) bool {
	if g.allow.Allowed(host) {
		return true
	}
	allowed := g.mode == "monitor" // monitor lets it through but still logs
	g.logAttempt(host, proto, allowed)
	return allowed
}

func (g *gateway) logAttempt(host, proto string, allowed bool) {
	decision := "blocked"
	if allowed {
		decision = "observed"
	}
	log.Printf("%s %s %s", decision, proto, host)
	if g.attempts == "" {
		return
	}
	line, _ := json.Marshal(map[string]any{
		"host": host, "proto": proto, "decision": decision,
		"mode": g.mode, "at": time.Now().UTC().Format(time.RFC3339),
	})
	g.mu.Lock()
	defer g.mu.Unlock()
	f, err := os.OpenFile(g.attempts, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	f.Write(append(line, '\n'))
}

// handleTLS peeks the ClientHello SNI, then splices to <sni>:443.
func (g *gateway) handleTLS(c net.Conn) {
	defer c.Close()
	c.SetReadDeadline(time.Now().Add(10 * time.Second))
	hello, sni, err := readClientHelloSNI(c)
	c.SetReadDeadline(time.Time{})
	if err != nil || sni == "" {
		g.logAttempt("(no-sni)", "tls", false)
		return // no SNI → can't allow-list → deny
	}
	if !g.decide(sni, "tls") {
		return
	}
	upstream, err := net.DialTimeout("tcp", net.JoinHostPort(sni, "443"), 10*time.Second)
	if err != nil {
		return
	}
	defer upstream.Close()
	upstream.Write(hello) // replay the buffered ClientHello
	splice(c, upstream)
}

// handleHTTP reads the request to get Host, then splices to <host>:80.
func (g *gateway) handleHTTP(c net.Conn) {
	defer c.Close()
	c.SetReadDeadline(time.Now().Add(10 * time.Second))
	br := bufio.NewReader(c)
	req, err := http.ReadRequest(br)
	c.SetReadDeadline(time.Time{})
	if err != nil {
		return
	}
	host := req.Host
	if host == "" {
		g.logAttempt("(no-host)", "http", false)
		return
	}
	if !g.decide(host, "http") {
		return
	}
	upstream, err := net.DialTimeout("tcp", net.JoinHostPort(normalizeHost(host), "80"), 10*time.Second)
	if err != nil {
		return
	}
	defer upstream.Close()
	req.Write(upstream)        // replay the parsed request
	io.Copy(upstream, br)      // any buffered/pipelined bytes
	splice(c, upstream)
}

func splice(a, b net.Conn) {
	done := make(chan struct{}, 2)
	go func() { io.Copy(a, b); done <- struct{}{} }()
	go func() { io.Copy(b, a); done <- struct{}{} }()
	<-done
}
