package main

import (
	"encoding/binary"
	"io"
	"log"
	"net"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// The allow-list is a list of HOSTNAMES, but a connection to an arbitrary port
// carries no name: only :443 (TLS SNI) and :80 (HTTP Host) name their
// destination in-band. SMTP, IMAP, databases, MQTT, SSH … dial a bare ip:port
// that the worker obtained from DNS moments earlier. So the proxy is also the
// worker's resolver (the netns owner points /etc/resolv.conf at us and our
// PREROUTING rule redirects :53 to the forwarder below): every A/AAAA answer
// we relay is remembered as ip → name, and the catch-all TCP path looks the
// destination IP back up to recover the name the worker resolved. That name
// goes through exactly the same decide()/allow-list/attempts-log path as an
// SNI or Host header does, so a blocked smtp.gmail.com:587 lands in the
// dashboard's "Needs review" as smtp.gmail.com — approvable like any host.
//
// Entries live for at least dnsMinTTL even when the record's TTL is shorter:
// a worker (or its language runtime) may cache the answer well past the TTL
// and connect later, and forgetting the name would turn a legitimate,
// allow-listed connection into an anonymous "1.2.3.4" that enforce mode
// blocks. Failing closed there is safe but confusing; a generous floor keeps
// the name attached. Entries are only ever a hint about identity — the dial
// itself goes to the exact IP the worker asked for, never to a re-resolution.

const (
	dnsMinTTL    = 6 * time.Hour
	dnsMaxNames  = 16    // names remembered per IP (CDN front-ends share IPs)
	dnsMaxIPs    = 65536 // hard cap on distinct IPs before oldest-first pruning
	dnsUpstreamT = 5 * time.Second
)

type dnsEntry struct {
	name    string
	seen    time.Time // last time this name resolved to the IP
	expires time.Time
}

type dnsCache struct {
	mu   sync.Mutex
	byIP map[string][]dnsEntry
	now  func() time.Time
}

func newDNSCache() *dnsCache {
	return &dnsCache{byIP: map[string][]dnsEntry{}, now: time.Now}
}

// Record remembers that name resolved to ip with the given TTL.
func (c *dnsCache) Record(name string, ip net.IP, ttl time.Duration) {
	name = normalizeHost(name)
	if name == "" || ip == nil {
		return
	}
	if ttl < dnsMinTTL {
		ttl = dnsMinTTL
	}
	now := c.now()
	key := ip.String()
	c.mu.Lock()
	defer c.mu.Unlock()
	entries := c.byIP[key]
	for i := range entries {
		if entries[i].name == name {
			entries[i].seen = now
			if exp := now.Add(ttl); exp.After(entries[i].expires) {
				entries[i].expires = exp
			}
			c.byIP[key] = entries
			return
		}
	}
	if len(entries) >= dnsMaxNames {
		// drop the least recently seen name for this IP
		sort.Slice(entries, func(i, j int) bool { return entries[i].seen.After(entries[j].seen) })
		entries = entries[:dnsMaxNames-1]
	}
	if _, exists := c.byIP[key]; !exists && len(c.byIP) >= dnsMaxIPs {
		c.pruneLocked(now)
	}
	c.byIP[key] = append(entries, dnsEntry{name: name, seen: now, expires: now.Add(ttl)})
}

// Names returns the unexpired names the worker resolved to ip, most recently
// resolved first — the head is almost always the name it is about to connect
// to.
func (c *dnsCache) Names(ip net.IP) []string {
	if ip == nil {
		return nil
	}
	now := c.now()
	c.mu.Lock()
	defer c.mu.Unlock()
	entries := c.byIP[ip.String()]
	live := make([]dnsEntry, 0, len(entries))
	for _, e := range entries {
		if e.expires.After(now) {
			live = append(live, e)
		}
	}
	if len(live) == 0 {
		delete(c.byIP, ip.String())
		return nil
	}
	sort.SliceStable(live, func(i, j int) bool { return live[i].seen.After(live[j].seen) })
	out := make([]string, len(live))
	for i, e := range live {
		out[i] = e.name
	}
	return out
}

// pruneLocked drops expired entries and, if the table is still over the cap,
// the least recently seen IPs. Called with c.mu held.
func (c *dnsCache) pruneLocked(now time.Time) {
	type aged struct {
		key  string
		seen time.Time
	}
	var ages []aged
	for key, entries := range c.byIP {
		live := entries[:0]
		latest := time.Time{}
		for _, e := range entries {
			if e.expires.After(now) {
				live = append(live, e)
				if e.seen.After(latest) {
					latest = e.seen
				}
			}
		}
		if len(live) == 0 {
			delete(c.byIP, key)
			continue
		}
		c.byIP[key] = live
		ages = append(ages, aged{key, latest})
	}
	if excess := len(c.byIP) - dnsMaxIPs/2; excess > 0 {
		sort.Slice(ages, func(i, j int) bool { return ages[i].seen.Before(ages[j].seen) })
		for _, a := range ages[:excess] {
			delete(c.byIP, a.key)
		}
	}
}

// Learn parses one DNS response and records every A/AAAA answer under the
// QUESTION name — the name the application asked for, which is what an
// operator recognises and allow-lists (CNAME chains such as
// smtp.gmail.com → gmail-smtp-msa.l.google.com would otherwise surface an
// infrastructure alias nobody would approve). Malformed responses are ignored.
func (c *dnsCache) Learn(msg []byte) {
	var p dnsmessage.Parser
	if _, err := p.Start(msg); err != nil {
		return
	}
	qs, err := p.AllQuestions()
	if err != nil || len(qs) == 0 {
		return
	}
	qname := strings.TrimSuffix(qs[0].Name.String(), ".")
	for {
		h, err := p.AnswerHeader()
		if err != nil {
			return // dnsmessage.ErrSectionDone or malformed — either way, stop
		}
		ttl := time.Duration(h.TTL) * time.Second
		switch h.Type {
		case dnsmessage.TypeA:
			r, err := p.AResource()
			if err != nil {
				return
			}
			c.Record(qname, net.IP(r.A[:]), ttl)
		case dnsmessage.TypeAAAA:
			r, err := p.AAAAResource()
			if err != nil {
				return
			}
			c.Record(qname, net.IP(r.AAAA[:]), ttl)
		default:
			if err := p.SkipAnswer(); err != nil {
				return
			}
		}
	}
}

// upstreamResolver is where the forwarder sends the worker's queries: the
// first nameserver in OUR /etc/resolv.conf — Docker's embedded DNS
// (127.0.0.11), which resolves the same stage-network service names for us as
// it would have for the worker (both containers sit on the same network).
func upstreamResolver() string {
	f, err := os.Open("/etc/resolv.conf")
	if err != nil {
		return "127.0.0.11:53"
	}
	defer f.Close()
	data, _ := io.ReadAll(io.LimitReader(f, 64<<10))
	for _, line := range strings.Split(string(data), "\n") {
		fs := strings.Fields(line)
		if len(fs) >= 2 && fs[0] == "nameserver" {
			if ip := net.ParseIP(fs[1]); ip != nil {
				return net.JoinHostPort(ip.String(), "53")
			}
		}
	}
	return "127.0.0.11:53"
}

// serveDNS runs the UDP+TCP forwarder on addr, relaying each query to
// upstream verbatim and learning from each response. It is a plain relay —
// no caching, no rewriting — so the worker sees exactly the answers Docker's
// resolver gives; we only take notes.
func serveDNS(cache *dnsCache, addr, upstream string) {
	udpAddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		log.Fatalf("dns: resolve %s: %v", addr, err)
	}
	uc, err := net.ListenUDP("udp", udpAddr)
	if err != nil {
		log.Fatalf("dns: listen udp %s: %v", addr, err)
	}
	tl := listen(addr)
	log.Printf("dns forwarder on %s → %s", addr, upstream)
	go func() {
		for {
			c, err := tl.Accept()
			if err != nil {
				continue
			}
			go serveDNSTCP(cache, c, upstream)
		}
	}()
	buf := make([]byte, 65535)
	for {
		n, peer, err := uc.ReadFromUDP(buf)
		if err != nil {
			continue
		}
		q := make([]byte, n)
		copy(q, buf[:n])
		go func() {
			resp, err := forwardDNSUDP(q, upstream)
			if err != nil {
				return // the client retries; nothing useful to say
			}
			cache.Learn(resp)
			uc.WriteToUDP(resp, peer)
		}()
	}
}

func forwardDNSUDP(q []byte, upstream string) ([]byte, error) {
	c, err := net.DialTimeout("udp", upstream, dnsUpstreamT)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(dnsUpstreamT))
	if _, err := c.Write(q); err != nil {
		return nil, err
	}
	buf := make([]byte, 65535)
	n, err := c.Read(buf)
	if err != nil {
		return nil, err
	}
	return buf[:n], nil
}

// serveDNSTCP relays length-prefixed queries over one TCP connection (used for
// large answers and zone-ish lookups; rare but must not break).
func serveDNSTCP(cache *dnsCache, c net.Conn, upstream string) {
	defer c.Close()
	up, err := net.DialTimeout("tcp", upstream, dnsUpstreamT)
	if err != nil {
		return
	}
	defer up.Close()
	for {
		c.SetReadDeadline(time.Now().Add(dnsUpstreamT))
		q, err := readDNSFrame(c)
		if err != nil {
			return
		}
		up.SetDeadline(time.Now().Add(dnsUpstreamT))
		if err := writeDNSFrame(up, q); err != nil {
			return
		}
		resp, err := readDNSFrame(up)
		if err != nil {
			return
		}
		cache.Learn(resp)
		c.SetWriteDeadline(time.Now().Add(dnsUpstreamT))
		if err := writeDNSFrame(c, resp); err != nil {
			return
		}
	}
}

func readDNSFrame(r io.Reader) ([]byte, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint16(hdr[:])
	msg := make([]byte, n)
	_, err := io.ReadFull(r, msg)
	return msg, err
}

func writeDNSFrame(w io.Writer, msg []byte) error {
	frame := make([]byte, 2+len(msg))
	binary.BigEndian.PutUint16(frame, uint16(len(msg)))
	copy(frame[2:], msg)
	_, err := w.Write(frame)
	return err
}
