package main

import (
	"net"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// buildResponse assembles a DNS response for qname with the given answers so
// Learn() can be exercised without a resolver.
func buildResponse(t *testing.T, qname string, answers []dnsmessage.Resource) []byte {
	t.Helper()
	name := dnsmessage.MustNewName(qname)
	msg := dnsmessage.Message{
		Header:    dnsmessage.Header{Response: true, ID: 1},
		Questions: []dnsmessage.Question{{Name: name, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET}},
		Answers:   answers,
	}
	b, err := msg.Pack()
	if err != nil {
		t.Fatalf("pack: %v", err)
	}
	return b
}

func aRecord(owner string, ttl uint32, ip [4]byte) dnsmessage.Resource {
	return dnsmessage.Resource{
		Header: dnsmessage.ResourceHeader{Name: dnsmessage.MustNewName(owner), Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET, TTL: ttl},
		Body:   &dnsmessage.AResource{A: ip},
	}
}

func cnameRecord(owner, target string) dnsmessage.Resource {
	return dnsmessage.Resource{
		Header: dnsmessage.ResourceHeader{Name: dnsmessage.MustNewName(owner), Type: dnsmessage.TypeCNAME, Class: dnsmessage.ClassINET, TTL: 60},
		Body:   &dnsmessage.CNAMEResource{CNAME: dnsmessage.MustNewName(target)},
	}
}

// The exact bug-report shape: the worker resolves smtp.gmail.com (a CNAME
// chain to a google.com alias) and dials the resulting IP on :587. The cache
// must attribute that IP to the name the application ASKED for — the one an
// operator recognises — not to the CNAME target.
func TestLearnRecordsQuestionNameThroughCNAME(t *testing.T) {
	c := newDNSCache()
	resp := buildResponse(t, "smtp.gmail.com.", []dnsmessage.Resource{
		cnameRecord("smtp.gmail.com.", "gmail-smtp-msa.l.google.com."),
		aRecord("gmail-smtp-msa.l.google.com.", 300, [4]byte{142, 251, 127, 109}),
	})
	c.Learn(resp)
	got := c.Names(net.ParseIP("142.251.127.109"))
	if len(got) != 1 || got[0] != "smtp.gmail.com" {
		t.Fatalf("Names() = %v, want [smtp.gmail.com]", got)
	}
	if c.Names(net.ParseIP("1.1.1.1")) != nil {
		t.Fatalf("unrelated IP must have no names")
	}
}

// Two names resolving to one IP (CDN front-ends) are both kept, most recently
// resolved first, so the catch-all attributes the connection to the name the
// worker just looked up.
func TestNamesMostRecentFirst(t *testing.T) {
	c := newDNSCache()
	now := time.Unix(1_700_000_000, 0)
	c.now = func() time.Time { return now }
	ip := net.ParseIP("203.0.113.7")
	c.Record("old.example.com", ip, time.Minute)
	now = now.Add(time.Second)
	c.Record("new.example.com", ip, time.Minute)
	if got := c.Names(ip); len(got) != 2 || got[0] != "new.example.com" || got[1] != "old.example.com" {
		t.Fatalf("Names() = %v", got)
	}
	// Re-resolving the older name makes it the most recent again.
	now = now.Add(time.Second)
	c.Record("old.example.com", ip, time.Minute)
	if got := c.Names(ip); got[0] != "old.example.com" {
		t.Fatalf("after re-resolve Names() = %v", got)
	}
}

// A short record TTL must not forget the name before an application that
// cached the answer connects: entries live for at least dnsMinTTL. After that
// floor they do expire.
func TestTTLFloorAndExpiry(t *testing.T) {
	c := newDNSCache()
	now := time.Unix(1_700_000_000, 0)
	c.now = func() time.Time { return now }
	ip := net.ParseIP("203.0.113.9")
	c.Record("short.example.com", ip, 5*time.Second)
	now = now.Add(time.Hour)
	if got := c.Names(ip); len(got) != 1 {
		t.Fatalf("name forgotten after 1h despite %v floor: %v", dnsMinTTL, got)
	}
	now = now.Add(dnsMinTTL)
	if got := c.Names(ip); got != nil {
		t.Fatalf("expired name still returned: %v", got)
	}
}

// decideNames: any allow-listed name for the IP admits the connection; an
// unknown destination with no names is judged (and logged) as its IP literal;
// enforce blocks and monitor observes.
func TestDecideNames(t *testing.T) {
	g := &gateway{mode: "enforce", allow: NewAllowList([]string{"smtp.gmail.com", "192.0.2.1"})}
	if host, ok := g.decideNames([]string{"cdn.example.net", "smtp.gmail.com"}, "142.251.127.109", "tcp", 587); !ok || host != "smtp.gmail.com" {
		t.Fatalf("allow-listed name among several: host=%q ok=%v", host, ok)
	}
	if host, ok := g.decideNames([]string{"dns.google"}, "8.8.8.8", "tcp", 53); ok || host != "dns.google" {
		t.Fatalf("unlisted name in enforce: host=%q ok=%v", host, ok)
	}
	if host, ok := g.decideNames(nil, "1.1.1.1", "tcp", 53); ok || host != "1.1.1.1" {
		t.Fatalf("nameless IP in enforce: host=%q ok=%v", host, ok)
	}
	if _, ok := g.decideNames(nil, "192.0.2.1", "tcp", 5432); !ok {
		t.Fatalf("allow-listed IP literal must be admitted")
	}
	g.mode = "monitor"
	if host, ok := g.decideNames([]string{"dns.google"}, "8.8.8.8", "tcp", 53); !ok || host != "dns.google" {
		t.Fatalf("monitor must observe-and-allow: host=%q ok=%v", host, ok)
	}
}
