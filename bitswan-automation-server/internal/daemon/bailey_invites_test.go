package daemon

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bitswan-space/bitswan-workspaces/internal/aoc"
)

// Tests for the invite lifecycle (bailey_people_invites.go +
// bailey_store_invites.go): admin create/list/revoke/resend, the
// untrusted-device redeem gate API, and the store's atomic consume.
// The AOC is faked at the newAOCInviteClient seam — no network.

// --- test doubles --------------------------------------------------------

type fakeAOCClient struct {
	users   []aoc.OrgUser
	listErr error
	sendErr error
	sent    []aoc.InviteEmailRequest
}

func (f *fakeAOCClient) ListOrgUsers() ([]aoc.OrgUser, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.users, nil
}

func (f *fakeAOCClient) SendInviteEmail(req aoc.InviteEmailRequest) error {
	f.sent = append(f.sent, req)
	return f.sendErr
}

func stubAOC(t *testing.T, f *fakeAOCClient) *fakeAOCClient {
	t.Helper()
	orig := newAOCInviteClient
	newAOCInviteClient = func() (aocInviteClient, error) { return f, nil }
	t.Cleanup(func() { newAOCInviteClient = orig })
	return f
}

func stubAOCUnavailable(t *testing.T) {
	t.Helper()
	orig := newAOCInviteClient
	newAOCInviteClient = func() (aocInviteClient, error) {
		return nil, fmt.Errorf("automation server not registered with an AOC")
	}
	t.Cleanup(func() { newAOCInviteClient = orig })
}

func cleanupInvite(t *testing.T, email string) {
	t.Helper()
	t.Cleanup(func() { _, _ = dbDeleteInvite(email) })
}

func cleanupUser(t *testing.T, email string) {
	t.Helper()
	t.Cleanup(func() {
		if devs, _ := dbListDevices(email); devs != nil {
			for _, d := range devs {
				_ = dbRemoveDevice(email, d.ID)
			}
		}
		_ = dbDeleteUserRole(email)
	})
}

// seedInvite plants an invite row directly and returns its raw token.
func seedInvite(t *testing.T, email, role string, ttl time.Duration) string {
	t.Helper()
	token, hash, err := generateInviteToken()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if err := dbUpsertInvite(&inviteRecord{
		Email: email, TokenHash: hash, Role: role,
		CreatedBy: "boss@example.com", CreatedAt: now, ExpiresAt: now.Add(ttl),
	}); err != nil {
		t.Fatal(err)
	}
	cleanupInvite(t, email)
	return token
}

func adminJSON(path, body string) *http.Request {
	return gateAPIJSON(http.MethodPost, path, "boss@example.com", body, adminGrp)
}

func apiInvite(t *testing.T, invitee, role string) *httptest.ResponseRecorder {
	t.Helper()
	cleanupInvite(t, invitee)
	return dispatch(adminJSON("/bailey/api/people/invite", fmt.Sprintf(`{"email":%q,"role":%q}`, invitee, role)))
}

func redeem(email, token string) *httptest.ResponseRecorder {
	return dispatch(gateAPIJSON(http.MethodPost, "/bailey/api/invite/redeem", email,
		fmt.Sprintf(`{"token":%q}`, token)))
}

func decodeBody(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("decode: %v\n%s", err, w.Body.String())
	}
	return m
}

// --- store ---------------------------------------------------------------

func TestInviteStore_CRUDAndAtomicConsume(t *testing.T) {
	email := "store-invitee@example.com"
	cleanupInvite(t, email)
	token, hash, err := generateInviteToken()
	if err != nil {
		t.Fatal(err)
	}
	if hash == token || hashInviteToken(token) != hash {
		t.Fatal("hash must be a digest of the token")
	}
	now := time.Now()
	inv := &inviteRecord{Email: email, TokenHash: hash, Role: roleMember,
		CreatedBy: "boss@example.com", CreatedAt: now, ExpiresAt: now.Add(inviteTTL)}
	if err := dbUpsertInvite(inv); err != nil {
		t.Fatal(err)
	}

	// The raw token is never a valid lookup key — only its hash is stored.
	if got, _ := dbLoadInviteByTokenHash(token); got != nil {
		t.Error("raw token resolved to a row; token must be hashed at rest")
	}
	got, err := dbLoadInviteByTokenHash(hash)
	if err != nil || got == nil {
		t.Fatalf("load by hash: %v, %v", got, err)
	}
	if got.Email != email || got.Role != roleMember || got.consumed() || !got.live(now) {
		t.Errorf("row mismatch: %+v", got)
	}
	// Email lookup is case-insensitive (COLLATE NOCASE).
	if got, _ := dbLoadInviteByEmail(strings.ToUpper(email)); got == nil {
		t.Error("case-variant email lookup found nothing")
	}

	// Atomic consume: exactly one winner.
	if ok, err := dbConsumeInviteAtomic(hash, now); err != nil || !ok {
		t.Fatalf("first consume = %v, %v; want true", ok, err)
	}
	if ok, _ := dbConsumeInviteAtomic(hash, now); ok {
		t.Error("second consume succeeded; must be single-use")
	}
	if got, _ := dbLoadInviteByEmail(email); got == nil || !got.consumed() {
		t.Error("row not marked consumed")
	}

	// Re-invite replaces the row wholesale (fresh token, unconsumed).
	_, hash2, _ := generateInviteToken()
	if err := dbUpsertInvite(&inviteRecord{Email: email, TokenHash: hash2, Role: roleAdmin,
		CreatedBy: "boss@example.com", CreatedAt: now, ExpiresAt: now.Add(inviteTTL)}); err != nil {
		t.Fatal(err)
	}
	got, _ = dbLoadInviteByEmail(email)
	if got == nil || got.consumed() || got.TokenHash != hash2 || got.Role != roleAdmin {
		t.Errorf("upsert did not replace: %+v", got)
	}
	if err := dbSetInviteEmailSent(email, true); err != nil {
		t.Fatal(err)
	}
	if got, _ := dbLoadInviteByEmail(email); got == nil || !got.EmailSent {
		t.Error("email_sent not persisted")
	}

	if deleted, _ := dbDeleteInvite(email); !deleted {
		t.Error("delete reported no row")
	}
	if deleted, _ := dbDeleteInvite(email); deleted {
		t.Error("second delete reported a row")
	}
}

func TestInviteStore_ConsumeRefusesExpired(t *testing.T) {
	email := "store-expired@example.com"
	token := seedInvite(t, email, roleMember, -time.Hour)
	if ok, _ := dbConsumeInviteAtomic(hashInviteToken(token), time.Now()); ok {
		t.Error("consumed an expired invite")
	}
}

// --- admin lifecycle endpoints -------------------------------------------

func TestInvite_CreateHappyPath(t *testing.T) {
	domain := writeTestConfig(t)
	markServerClaimed(t)
	invitee := "invitee-happy@example.com"
	// AOC knows the address with different casing — the daemon must adopt
	// the AOC's canonical form.
	f := stubAOC(t, &fakeAOCClient{users: []aoc.OrgUser{{Email: "Invitee-Happy@example.com", Username: "grace", Verified: true}}})

	w := apiInvite(t, invitee, roleMember)
	if w.Code != http.StatusOK {
		t.Fatalf("invite = %d\n%s", w.Code, w.Body.String())
	}
	resp := decodeBody(t, w)
	if resp["email_sent"] != true {
		t.Errorf("email_sent = %v, want true", resp["email_sent"])
	}
	link, _ := resp["invite_link"].(string)
	wantPrefix := "https://bailey-onboard." + domain + "/?invite="
	if !strings.HasPrefix(link, wantPrefix) {
		t.Fatalf("invite_link = %q, want prefix %q (onboarding host, never the console host)", link, wantPrefix)
	}
	token := strings.TrimPrefix(link, wantPrefix)

	inv, _ := dbLoadInviteByEmail(invitee)
	if inv == nil {
		t.Fatal("no invite row created")
	}
	if inv.Email != "Invitee-Happy@example.com" {
		t.Errorf("stored email %q, want AOC-canonical casing", inv.Email)
	}
	if inv.TokenHash != hashInviteToken(token) {
		t.Error("stored hash doesn't match the token in the link")
	}
	if !inv.EmailSent || inv.Role != roleMember {
		t.Errorf("row = %+v", inv)
	}
	if until := time.Until(inv.ExpiresAt); until < inviteTTL-time.Minute || until > inviteTTL {
		t.Errorf("expiry %v from now, want ~%v", until, inviteTTL)
	}
	if len(f.sent) != 1 || f.sent[0].InviteURL != link || f.sent[0].InvitedBy != "boss@example.com" {
		t.Errorf("AOC email request = %+v", f.sent)
	}
}

func TestInvite_CreateFailsClosedOnAOCAndMembership(t *testing.T) {
	writeTestConfig(t)
	markServerClaimed(t)
	invitee := "invitee-noorg@example.com"

	// Not a member of the org → 400 not_in_org, nothing stored.
	stubAOC(t, &fakeAOCClient{users: []aoc.OrgUser{{Email: "someone-else@example.com"}}})
	w := apiInvite(t, invitee, roleMember)
	if w.Code != http.StatusBadRequest || decodeBody(t, w)["code"] != "not_in_org" {
		t.Errorf("non-member invite = %d %s", w.Code, w.Body.String())
	}
	if inv, _ := dbLoadInviteByEmail(invitee); inv != nil {
		t.Error("invite stored despite failed membership check")
	}

	// AOC list failing → 502, nothing stored (fail closed, not open).
	stubAOC(t, &fakeAOCClient{listErr: fmt.Errorf("boom")})
	if w := apiInvite(t, invitee, roleMember); w.Code != http.StatusBadGateway {
		t.Errorf("AOC error invite = %d", w.Code)
	}
	stubAOCUnavailable(t)
	if w := apiInvite(t, invitee, roleMember); w.Code != http.StatusBadGateway {
		t.Errorf("AOC unconfigured invite = %d", w.Code)
	}
	if inv, _ := dbLoadInviteByEmail(invitee); inv != nil {
		t.Error("invite stored despite AOC being unreachable")
	}
}

func TestInvite_CreateValidation(t *testing.T) {
	writeTestConfig(t)
	markServerClaimed(t)
	stubAOC(t, &fakeAOCClient{users: []aoc.OrgUser{{Email: "invitee-val@example.com"}}})

	// Only member/admin are invitable roles.
	if w := apiInvite(t, "invitee-val@example.com", roleAuditor); w.Code != http.StatusBadRequest {
		t.Errorf("auditor invite = %d, want 400", w.Code)
	}
	if w := dispatch(adminJSON("/bailey/api/people/invite", `{"role":"member"}`)); w.Code != http.StatusBadRequest {
		t.Errorf("missing email = %d, want 400", w.Code)
	}

	// Someone with a trusted device can't be invited — they're already in.
	trusted := "invitee-trusted@example.com"
	cleanupUser(t, trusted)
	if _, err := addDevice(trusted, "their laptop"); err != nil {
		t.Fatal(err)
	}
	stubAOC(t, &fakeAOCClient{users: []aoc.OrgUser{{Email: trusted}}})
	w := apiInvite(t, trusted, roleMember)
	if w.Code != http.StatusConflict || decodeBody(t, w)["code"] != "already_trusted" {
		t.Errorf("trusted-user invite = %d %s", w.Code, w.Body.String())
	}

	// Non-admin caller never reaches the handler (dispatcher admin gate).
	r := gateAPIJSON(http.MethodPost, "/bailey/api/people/invite", "pleb@example.com", `{"email":"x@example.com"}`)
	if w := dispatch(r); w.Code != http.StatusForbidden {
		t.Errorf("non-admin invite = %d, want 403", w.Code)
	}
}

func TestInvite_EmailFailureStillReturnsLink(t *testing.T) {
	writeTestConfig(t)
	markServerClaimed(t)
	invitee := "invitee-smtpless@example.com"
	stubAOC(t, &fakeAOCClient{
		users:   []aoc.OrgUser{{Email: invitee}},
		sendErr: &aoc.InviteEmailError{StatusCode: 409, Code: "smtp_not_configured", Message: "SMTP is not configured"},
	})
	w := apiInvite(t, invitee, roleMember)
	if w.Code != http.StatusOK {
		t.Fatalf("invite = %d\n%s", w.Code, w.Body.String())
	}
	resp := decodeBody(t, w)
	if resp["email_sent"] != false {
		t.Error("email_sent should be false when the AOC couldn't deliver")
	}
	if link, _ := resp["invite_link"].(string); link == "" {
		t.Error("no copyable invite_link on email failure — the mandated fallback")
	}
	if errText, _ := resp["email_error"].(string); !strings.Contains(errText, "smtp_not_configured") {
		t.Errorf("email_error = %q, want the AOC failure surfaced", errText)
	}
	if inv, _ := dbLoadInviteByEmail(invitee); inv == nil || inv.EmailSent {
		t.Error("row should exist with email_sent=false")
	}
}

func TestInvite_ListResendRevoke(t *testing.T) {
	writeTestConfig(t)
	markServerClaimed(t)
	invitee := "invitee-lifecycle@example.com"
	stubAOC(t, &fakeAOCClient{users: []aoc.OrgUser{{Email: invitee}}})
	if w := apiInvite(t, invitee, roleAdmin); w.Code != http.StatusOK {
		t.Fatalf("create: %d\n%s", w.Code, w.Body.String())
	}
	before, _ := dbLoadInviteByEmail(invitee)

	// List shows the outstanding invite.
	w := dispatch(baileyReq(http.MethodGet, "/bailey/api/people/invites", "boss@example.com", adminGrp))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), invitee) {
		t.Fatalf("list = %d\n%s", w.Code, w.Body.String())
	}

	// Resend re-mints the token and keeps the role; the old link dies.
	w = dispatch(adminJSON("/bailey/api/people/invites/resend", fmt.Sprintf(`{"email":%q}`, invitee)))
	if w.Code != http.StatusOK {
		t.Fatalf("resend = %d\n%s", w.Code, w.Body.String())
	}
	after, _ := dbLoadInviteByEmail(invitee)
	if after == nil || after.TokenHash == before.TokenHash {
		t.Error("resend must rotate the token")
	}
	if after.Role != roleAdmin || after.CreatedBy != before.CreatedBy {
		t.Errorf("resend changed role/creator: %+v", after)
	}

	// The invited-but-never-seen user shows up in the roster as invited,
	// carrying the role the invite will grant.
	w = dispatch(baileyReq(http.MethodGet, "/bailey/api/people", "boss@example.com", adminGrp))
	var roster struct {
		People []personDTO `json:"people"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &roster)
	found := false
	for _, p := range roster.People {
		if strings.EqualFold(p.Email, invitee) {
			found = true
			if !p.InvitedOnly || p.Role != roleAdmin {
				t.Errorf("roster row = %+v, want invited=true role=admin", p)
			}
		}
	}
	if !found {
		t.Error("invited user missing from roster")
	}

	// Revoke removes it; a second revoke (and resend) 404.
	w = dispatch(adminJSON("/bailey/api/people/invites/revoke", fmt.Sprintf(`{"email":%q}`, invitee)))
	if w.Code != http.StatusOK {
		t.Fatalf("revoke = %d", w.Code)
	}
	if w := dispatch(adminJSON("/bailey/api/people/invites/revoke", fmt.Sprintf(`{"email":%q}`, invitee))); w.Code != http.StatusNotFound {
		t.Errorf("second revoke = %d, want 404", w.Code)
	}
	if w := dispatch(adminJSON("/bailey/api/people/invites/resend", fmt.Sprintf(`{"email":%q}`, invitee))); w.Code != http.StatusNotFound {
		t.Errorf("resend after revoke = %d, want 404", w.Code)
	}
}

func TestInvite_OrgUsersAnnotatesLocalState(t *testing.T) {
	writeTestConfig(t)
	markServerClaimed(t)
	member := "orguser-fresh@example.com"
	rostered := "orguser-rostered@example.com"
	invited := "orguser-invited@example.com"
	cleanupUser(t, rostered)
	if _, err := addDevice(rostered, "laptop"); err != nil {
		t.Fatal(err)
	}
	seedInvite(t, invited, roleMember, inviteTTL)
	stubAOC(t, &fakeAOCClient{users: []aoc.OrgUser{
		{Email: member}, {Email: rostered}, {Email: invited},
	}})

	w := dispatch(baileyReq(http.MethodGet, "/bailey/api/people/org-users", "boss@example.com", adminGrp))
	if w.Code != http.StatusOK {
		t.Fatalf("org-users = %d\n%s", w.Code, w.Body.String())
	}
	var resp struct {
		Users []struct {
			Email    string `json:"email"`
			InRoster bool   `json:"in_roster"`
			Invited  bool   `json:"invited"`
		} `json:"users"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	state := map[string][2]bool{}
	for _, u := range resp.Users {
		state[strings.ToLower(u.Email)] = [2]bool{u.InRoster, u.Invited}
	}
	if s := state[member]; s[0] || s[1] {
		t.Errorf("fresh member state = %v, want neither", s)
	}
	if s := state[rostered]; !s[0] {
		t.Errorf("rostered member in_roster = false")
	}
	if s := state[invited]; s[0] || !s[1] {
		t.Errorf("invited member state = %v, want invited only", s)
	}

	// AOC down → 502, not an empty 200.
	stubAOCUnavailable(t)
	if w := dispatch(baileyReq(http.MethodGet, "/bailey/api/people/org-users", "boss@example.com", adminGrp)); w.Code != http.StatusBadGateway {
		t.Errorf("org-users with AOC down = %d, want 502", w.Code)
	}
}

// --- redeem gate API -----------------------------------------------------

func TestInviteRedeem_HappyPathTrustsFirstDeviceOnly(t *testing.T) {
	writeTestConfig(t)
	markServerClaimed(t)
	invitee := "redeemer@example.com"
	cleanupUser(t, invitee)
	token := seedInvite(t, invitee, roleAdmin, inviteTTL)

	w := redeem(invitee, token)
	if w.Code != http.StatusOK {
		t.Fatalf("redeem = %d\n%s", w.Code, w.Body.String())
	}
	resp := decodeBody(t, w)
	if resp["ok"] != true || resp["redirect_path"] == "" {
		t.Errorf("resp = %v", resp)
	}
	// THIS browser got a device cookie and a device row.
	cookies := w.Result().Cookies()
	haveDevice := false
	for _, c := range cookies {
		if c.Name == deviceCookieName && c.Value != "" {
			haveDevice = true
		}
	}
	if !haveDevice {
		t.Error("no device cookie set on redeem")
	}
	devs, _ := dbListDevices(invitee)
	if len(devs) != 1 {
		t.Fatalf("device rows = %d, want 1", len(devs))
	}
	if !strings.Contains(devs[0].Name, "invite from boss@example.com") {
		t.Errorf("device name %q should carry the inviter", devs[0].Name)
	}
	// Invite is burned, the invited role applied.
	if inv, _ := dbLoadInviteByEmail(invitee); inv == nil || !inv.consumed() {
		t.Error("invite not consumed")
	}
	if effectiveRole(invitee) != roleAdmin {
		t.Errorf("role = %q, want the invited role", effectiveRole(invitee))
	}
	// Same link again: single-use.
	if w := redeem(invitee, token); w.Code != http.StatusGone || decodeBody(t, w)["code"] != "consumed" {
		t.Errorf("second redeem = %d %s, want 410 consumed", w.Code, w.Body.String())
	}
}

func TestInviteRedeem_Rejections(t *testing.T) {
	writeTestConfig(t)
	markServerClaimed(t)

	// Unknown / missing token.
	if w := redeem("who@example.com", "not-a-real-token"); w.Code != http.StatusNotFound {
		t.Errorf("unknown token = %d, want 404", w.Code)
	}
	if w := redeem("who@example.com", ""); w.Code != http.StatusBadRequest {
		t.Errorf("empty token = %d, want 400", w.Code)
	}
	// No identity → 401 (requireIdentity).
	if w := redeem("", "sometoken"); w.Code != http.StatusUnauthorized {
		t.Errorf("no identity = %d, want 401", w.Code)
	}

	// Expired.
	expiredUser := "redeem-expired@example.com"
	cleanupUser(t, expiredUser)
	tokenExp := seedInvite(t, expiredUser, roleMember, -time.Hour)
	if w := redeem(expiredUser, tokenExp); w.Code != http.StatusGone || decodeBody(t, w)["code"] != "expired" {
		t.Errorf("expired redeem = %d, want 410 expired", w.Code)
	}
	if devs, _ := dbListDevices(expiredUser); len(devs) != 0 {
		t.Error("expired redeem minted a device")
	}

	// Wrong account: bound to the invitee, and the response must not leak
	// who the invite was for.
	target := "redeem-target@example.com"
	tokenT := seedInvite(t, target, roleMember, inviteTTL)
	w := redeem("attacker@example.com", tokenT)
	if w.Code != http.StatusForbidden || decodeBody(t, w)["code"] != "wrong_account" {
		t.Errorf("wrong-account redeem = %d %s", w.Code, w.Body.String())
	}
	if strings.Contains(strings.ToLower(w.Body.String()), target[:strings.Index(target, "@")]) {
		t.Error("wrong-account error leaks the invitee address")
	}
	if inv, _ := dbLoadInviteByEmail(target); inv == nil || inv.consumed() {
		t.Error("wrong-account attempt must not burn the invite")
	}

	// Case-variant email of the right account IS the right account.
	if w := redeem(strings.ToUpper(target), tokenT); w.Code != http.StatusOK {
		t.Errorf("case-variant redeem = %d, want 200", w.Code)
	}
	cleanupUser(t, target)

	// Already trusted: first-device only.
	trusted := "redeem-trusted@example.com"
	cleanupUser(t, trusted)
	if _, err := addDevice(trusted, "existing laptop"); err != nil {
		t.Fatal(err)
	}
	tokenTr := seedInvite(t, trusted, roleMember, inviteTTL)
	w = redeem(trusted, tokenTr)
	if w.Code != http.StatusConflict || decodeBody(t, w)["code"] != "already_trusted" {
		t.Errorf("already-trusted redeem = %d %s", w.Code, w.Body.String())
	}
	if inv, _ := dbLoadInviteByEmail(trusted); inv == nil || inv.consumed() {
		t.Error("already-trusted attempt must not burn the invite")
	}
	if devs, _ := dbListDevices(trusted); len(devs) != 1 {
		t.Error("already-trusted redeem minted an extra device")
	}
}

func TestInviteRedeem_RefusedOnUnclaimedServer(t *testing.T) {
	writeTestConfig(t)
	resetClaimState(t)
	t.Cleanup(func() { markServerClaimed(t) })
	invitee := "redeem-unclaimed@example.com"
	token := seedInvite(t, invitee, roleMember, inviteTTL)
	w := redeem(invitee, token)
	if w.Code != http.StatusConflict || decodeBody(t, w)["code"] != "unclaimed" {
		t.Errorf("unclaimed redeem = %d %s, want 409 unclaimed", w.Code, w.Body.String())
	}
	if devs, _ := dbListDevices(invitee); len(devs) != 0 {
		t.Error("redeem minted the bootstrap device on an unclaimed server")
	}
}

func TestInviteRedeem_NeverDowngradesAnExplicitRole(t *testing.T) {
	writeTestConfig(t)
	markServerClaimed(t)
	invitee := "redeem-hasrole@example.com"
	cleanupUser(t, invitee)
	if err := dbSetUserRole(invitee, roleAdmin, "an-admin@example.com"); err != nil {
		t.Fatal(err)
	}
	token := seedInvite(t, invitee, roleMember, inviteTTL)
	if w := redeem(invitee, token); w.Code != http.StatusOK {
		t.Fatalf("redeem = %d", w.Code)
	}
	if effectiveRole(invitee) != roleAdmin {
		t.Errorf("role = %q; a member invite must not demote an explicit admin", effectiveRole(invitee))
	}
}

func TestGateState_ReportsPendingInvite(t *testing.T) {
	writeTestConfig(t)
	markServerClaimed(t)
	invitee := "gatestate-invited@example.com"
	cleanupUser(t, invitee)
	token := seedInvite(t, invitee, roleMember, inviteTTL)

	var st gateState
	w := dispatch(gateAPIReq(http.MethodGet, "/bailey/api/gate-state", invitee))
	_ = json.Unmarshal(w.Body.Bytes(), &st)
	if !st.InvitePending {
		t.Error("invite_pending = false with a live invite")
	}

	if w := redeem(invitee, token); w.Code != http.StatusOK {
		t.Fatalf("redeem = %d", w.Code)
	}
	w = dispatch(gateAPIReq(http.MethodGet, "/bailey/api/gate-state", invitee))
	_ = json.Unmarshal(w.Body.Bytes(), &st)
	if st.InvitePending {
		t.Error("invite_pending = true after the invite was consumed")
	}
	if !st.HasTrustedDevice {
		t.Error("has_trusted_device = false after redeem minted the first device")
	}
}
