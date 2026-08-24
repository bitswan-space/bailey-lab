package daemon

import (
	"errors"
	"net/url"
	"sort"
	"strings"
	"testing"

	"github.com/bitswan-space/bitswan-workspaces/internal/aoc"
)

// fakeOAuthRegistrar records what the daemon asks the AOC to register.
// It is deliberately dumb: the point of these tests is the SET of URIs
// the daemon states, not what Keycloak then does with them.
type fakeOAuthRegistrar struct {
	callbacks   []string
	postLogouts []string
	failOn      string
}

func (f *fakeOAuthRegistrar) GetOrCreateOAuthClientWithPostLogout(service, redirectURI, postLogoutURI string) (*aoc.OAuthClientResponse, error) {
	if service != "bitswan-protected" {
		return nil, errors.New("unexpected service " + service)
	}
	if f.failOn != "" && strings.Contains(redirectURI, f.failOn) {
		return nil, errors.New("AOC rejected " + redirectURI)
	}
	f.callbacks = append(f.callbacks, redirectURI)
	f.postLogouts = append(f.postLogouts, postLogoutURI)
	return &aoc.OAuthClientResponse{ClientID: "test-client", IssuerURL: "https://kc.example.com/realms/master"}, nil
}

// stubAOCOAuthClient installs the fake for the duration of a test.
func stubAOCOAuthClient(t *testing.T, f *fakeOAuthRegistrar) {
	t.Helper()
	orig := newAOCOAuthClient
	newAOCOAuthClient = func() (aocOAuthClient, error) { return f, nil }
	t.Cleanup(func() { newAOCOAuthClient = orig })
}

// The login and logout allowlists are two independent lists in Keycloak,
// and an endpoint on one but not the other is exactly the reported bug:
// signing in works, signing out shows "Invalid redirect uri". So the
// derived pair set must always be symmetric, and must cover the outer
// (chrome wrap) and --inner (content iframe) hostname alike.
func TestProtectedClientURIsForHost(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  []protectedClientURIs
	}{
		{
			name:  "outer host yields outer and inner pairs",
			input: "wraptest-dashboard.example.com",
			want: []protectedClientURIs{
				{
					Host:       "wraptest-dashboard.example.com",
					Callback:   "https://wraptest-dashboard.example.com/oauth2/callback",
					PostLogout: "https://wraptest-dashboard.example.com/",
				},
				{
					Host:       "wraptest-dashboard--inner.example.com",
					Callback:   "https://wraptest-dashboard--inner.example.com/oauth2/callback",
					PostLogout: "https://wraptest-dashboard--inner.example.com/",
				},
			},
		},
		{
			// Handed the inner twin, it must produce the same set —
			// otherwise a caller with the wrong twin in hand registers
			// half an endpoint and nothing ever notices.
			name:  "inner host yields the same pairs",
			input: "wraptest-dashboard--inner.example.com",
			want: []protectedClientURIs{
				{
					Host:       "wraptest-dashboard.example.com",
					Callback:   "https://wraptest-dashboard.example.com/oauth2/callback",
					PostLogout: "https://wraptest-dashboard.example.com/",
				},
				{
					Host:       "wraptest-dashboard--inner.example.com",
					Callback:   "https://wraptest-dashboard--inner.example.com/oauth2/callback",
					PostLogout: "https://wraptest-dashboard--inner.example.com/",
				},
			},
		},
		{
			name:  "bailey management host",
			input: "bailey.example.com",
			want: []protectedClientURIs{
				{
					Host:       "bailey.example.com",
					Callback:   "https://bailey.example.com/oauth2/callback",
					PostLogout: "https://bailey.example.com/",
				},
				{
					Host:       "bailey--inner.example.com",
					Callback:   "https://bailey--inner.example.com/oauth2/callback",
					PostLogout: "https://bailey--inner.example.com/",
				},
			},
		},
		{
			name:  "empty hostname registers nothing",
			input: "",
			want:  nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := protectedClientURIsForHost(tc.input)
			if len(got) != len(tc.want) {
				t.Fatalf("got %d pair(s) %+v, want %d", len(got), got, len(tc.want))
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Errorf("pair %d = %+v, want %+v", i, got[i], tc.want[i])
				}
			}
			// The invariant, asserted independently of the table: one
			// post-logout target per callback, on the very same host.
			for _, p := range got {
				cb, err := url.Parse(p.Callback)
				if err != nil {
					t.Fatalf("callback %q: %v", p.Callback, err)
				}
				pl, err := url.Parse(p.PostLogout)
				if err != nil {
					t.Fatalf("post-logout %q: %v", p.PostLogout, err)
				}
				if cb.Host != pl.Host || cb.Host != p.Host {
					t.Errorf("pair hosts disagree: callback %s, post-logout %s, host %s", cb.Host, pl.Host, p.Host)
				}
				if cb.Path != "/oauth2/callback" {
					t.Errorf("callback path = %q, want /oauth2/callback", cb.Path)
				}
				// The Logout button posts back to the endpoint root
				// (logoutURLForHost / signoutRedirect); anything else
				// would not match in Keycloak, which compares exactly.
				if pl.Path != "/" {
					t.Errorf("post-logout path = %q, want /", pl.Path)
				}
			}
		})
	}
}

// Registration must state both lists in the same breath. If it ever goes
// back to registering callbacks alone, this fails.
func TestRegisterProtectedRedirectURI_RegistersBothLists(t *testing.T) {
	f := &fakeOAuthRegistrar{}
	stubAOCOAuthClient(t, f)

	if err := registerProtectedRedirectURI("regtest-dashboard.example.com"); err != nil {
		t.Fatalf("register: %v", err)
	}

	wantCallbacks := []string{
		"https://regtest-dashboard.example.com/oauth2/callback",
		"https://regtest-dashboard--inner.example.com/oauth2/callback",
	}
	wantPostLogouts := []string{
		"https://regtest-dashboard.example.com/",
		"https://regtest-dashboard--inner.example.com/",
	}
	if !equalStrings(f.callbacks, wantCallbacks) {
		t.Errorf("callbacks = %v, want %v", f.callbacks, wantCallbacks)
	}
	if !equalStrings(f.postLogouts, wantPostLogouts) {
		t.Errorf("post-logout URIs = %v, want %v", f.postLogouts, wantPostLogouts)
	}
}

// A rejected URI is an error, not a shrug: the caller decides how loud to
// be, but it must be told.
func TestRegisterProtectedRedirectURI_PropagatesFailure(t *testing.T) {
	f := &fakeOAuthRegistrar{failOn: "--inner"}
	stubAOCOAuthClient(t, f)

	err := registerProtectedRedirectURI("failtest-dashboard.example.com")
	if err == nil {
		t.Fatal("a rejected registration returned no error")
	}
	if !strings.Contains(err.Error(), "--inner") {
		t.Errorf("error should name the URI that failed, got %v", err)
	}
}

// The reconcile is the half of the fix that repairs servers which are
// already drifted: it must cover every host the daemon knows about —
// routes AND ACL endpoints, deduplicated — and it must state the pair for
// each of them.
func TestReconcileProtectedRedirectURIs_CoversEveryKnownHost(t *testing.T) {
	domain := writeTestConfig(t)
	routeOnly := "recon-route." + domain
	endpointOnly := "recon-endpoint." + domain
	both := "recon-both." + domain

	if err := saveProtectedRoute(routeOnly, "upstream:80"); err != nil {
		t.Fatal(err)
	}
	if err := saveProtectedRoute(both, "upstream:80"); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint(endpointOnly, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := registerEndpoint(both, "owner@example.com", "", "", "", ""); err != nil {
		t.Fatal(err)
	}

	f := &fakeOAuthRegistrar{}
	stubAOCOAuthClient(t, f)

	reconcileProtectedRedirectURIs()

	for _, h := range []string{routeOnly, endpointOnly, both} {
		for _, p := range protectedClientURIsForHost(h) {
			if !contains(f.callbacks, p.Callback) {
				t.Errorf("reconcile did not register callback %s", p.Callback)
			}
			if !contains(f.postLogouts, p.PostLogout) {
				t.Errorf("reconcile did not register post-logout %s", p.PostLogout)
			}
		}
	}

	// Symmetric by construction: as many post-logout URIs as callbacks,
	// and every callback's host appears in the post-logout list.
	if len(f.callbacks) != len(f.postLogouts) {
		t.Fatalf("%d callbacks vs %d post-logout URIs — the lists drifted", len(f.callbacks), len(f.postLogouts))
	}
	for _, cb := range f.callbacks {
		twin := strings.TrimSuffix(cb, "oauth2/callback")
		if !contains(f.postLogouts, twin) {
			t.Errorf("callback %s has no post-logout twin %s", cb, twin)
		}
	}

	// A host appearing in both tables is one registration, not two.
	hosts, err := knownProtectedHosts()
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]int{}
	for _, h := range hosts {
		seen[h]++
	}
	if seen[both] != 1 {
		t.Errorf("host in both tables listed %d times, want 1", seen[both])
	}
	if !sort.StringsAreSorted(hosts) {
		t.Error("known hosts should come back sorted (stable log output)")
	}
}

// The reconcile only ever adds. It has no vocabulary for removal, and the
// shared client carries other products' endpoints, so this guards the
// absence of a prune as much as the presence of an add.
func TestReconcileProtectedRedirectURIs_NeverRemovesForeignURIs(t *testing.T) {
	writeTestConfig(t)
	f := &fakeOAuthRegistrar{}
	stubAOCOAuthClient(t, f)

	reconcileProtectedRedirectURIs()

	hosts, err := knownProtectedHosts()
	if err != nil {
		t.Fatal(err)
	}
	known := map[string]bool{}
	for _, h := range hosts {
		for _, p := range protectedClientURIsForHost(h) {
			known[p.Callback] = true
			known[p.PostLogout] = true
		}
	}
	for _, u := range append(append([]string{}, f.callbacks...), f.postLogouts...) {
		if !known[u] {
			t.Errorf("reconcile touched %s, which is not one of this server's hosts", u)
		}
	}
}

// A protected domain can be configured on a server with no AOC credentials.
// The sweep must then give up once, before it starts, rather than fail its way
// through every hostname it knows.
func TestReconcileProtectedRedirectURIs_NoAOCGivesUpOnce(t *testing.T) {
	writeTestConfig(t)
	var constructed int
	orig := newAOCOAuthClient
	newAOCOAuthClient = func() (aocOAuthClient, error) {
		constructed++
		return nil, errors.New("access_token is not set")
	}
	t.Cleanup(func() { newAOCOAuthClient = orig })

	reconcileProtectedRedirectURIs()

	if constructed != 1 {
		t.Errorf("built the AOC client %d times, want 1 for the whole sweep", constructed)
	}
}

// Without a configured protected domain there is no protected ingress and
// nothing to reconcile — and, crucially, no AOC call to make.
func TestReconcileProtectedRedirectURIs_NoDomainIsANoop(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("SUDO_USER", "")
	f := &fakeOAuthRegistrar{}
	stubAOCOAuthClient(t, f)

	reconcileProtectedRedirectURIs()

	if len(f.callbacks) != 0 {
		t.Errorf("reconciled %d URI(s) with no domain configured", len(f.callbacks))
	}
}

func equalStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range want {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

func contains(hay []string, needle string) bool {
	for _, h := range hay {
		if h == needle {
			return true
		}
	}
	return false
}
