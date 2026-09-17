package daemon

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// agentIdentity is one test user the coding agent invented for itself (issue
// #210): an email and a set of groups that exist ONLY in the daemon's own
// issuer (agent_idp.go). Nothing is written to Keycloak, and nothing here
// grants any role in Bailey's own store — the identity proves who the browser
// claims to be to a live-dev app, and that is its entire authority.
type agentIdentity struct {
	Label     string    `json:"label"`
	Email     string    `json:"email"`
	Groups    []string  `json:"groups"`
	Workspace string    `json:"workspace"`
	CreatedAt time.Time `json:"created_at"`
}

// agentSession is one browser session handed to the agent for one live-dev
// endpoint. Only the hash is stored; the raw value lives in the cookie.
type agentSession struct {
	Label        string    `json:"label"`
	EndpointHost string    `json:"endpoint_host"`
	Workspace    string    `json:"workspace"`
	ExpiresAt    time.Time `json:"expires_at"`
	// TokenHash is set on a lookup so the hand-over path can recognise the row
	// it found; the raw cookie value is never stored and never recoverable.
	TokenHash string `json:"-"`
}

// agentSessionCookie is the cookie the gate looks for. The name is deliberately
// in Bailey's own _bailey_ family so stripBaileyAuthCookies removes it before a
// request reaches a tenant app.
const agentSessionCookie = "_bailey_agent"

// agentSessionTTL bounds how long one handed-out session stays usable. A
// session bypasses the sign-in on its endpoint, so it expires on its own even
// if the agent never revokes it.
const agentSessionTTL = 12 * time.Hour

var agentLabelRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$`)

// validateAgentLabel keeps a label usable as an identifier the agent types on a
// command line and as a SQL key: lowercase, hyphenated, bounded.
func validateAgentLabel(label string) (string, error) {
	l := strings.ToLower(strings.TrimSpace(label))
	if !agentLabelRe.MatchString(l) {
		return "", fmt.Errorf("label must be 2-40 lowercase letters, digits or hyphens, starting and ending alphanumeric")
	}
	return l, nil
}

// defaultAgentEmail is the address a test identity gets when the agent does not
// name one. The .invalid TLD is reserved by RFC 2606 and can never resolve or
// receive mail, so a test identity can never be confused with a person's
// address or collide with a real account anywhere.
func defaultAgentEmail(label, workspace string) string {
	ws := strings.ToLower(strings.TrimSpace(workspace))
	if ws == "" {
		ws = "workspace"
	}
	return label + "@" + ws + ".agent.invalid"
}

func dbUpsertAgentIdentity(id agentIdentity) error {
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	groups, err := json.Marshal(id.Groups)
	if err != nil {
		return err
	}
	_, err = db.Exec(
		`INSERT INTO agent_identities(label, email, groups_json, workspace, created_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(label) DO UPDATE SET email=excluded.email,
		   groups_json=excluded.groups_json, workspace=excluded.workspace`,
		id.Label, id.Email, string(groups), id.Workspace,
		time.Now().UTC().Format(time.RFC3339),
	)
	return err
}

func scanAgentIdentity(row interface{ Scan(...any) error }) (*agentIdentity, error) {
	var (
		id        agentIdentity
		groups    string
		createdAt string
	)
	if err := row.Scan(&id.Label, &id.Email, &groups, &id.Workspace, &createdAt); err != nil {
		return nil, err
	}
	if err := json.Unmarshal([]byte(groups), &id.Groups); err != nil {
		return nil, fmt.Errorf("stored groups for %s are corrupt: %w", id.Label, err)
	}
	id.CreatedAt, _ = time.Parse(time.RFC3339, createdAt)
	return &id, nil
}

const agentIdentityColumns = `label, email, groups_json, workspace, created_at`

// dbGetAgentIdentity returns the identity, or nil when there is no such label.
func dbGetAgentIdentity(label string) (*agentIdentity, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	row := db.QueryRow(`SELECT `+agentIdentityColumns+` FROM agent_identities WHERE label = ?`, label)
	id, err := scanAgentIdentity(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return id, err
}

func dbListAgentIdentities(workspace string) ([]agentIdentity, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	rows, err := db.Query(`SELECT `+agentIdentityColumns+` FROM agent_identities WHERE workspace = ? ORDER BY label`, workspace)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []agentIdentity{}
	for rows.Next() {
		id, err := scanAgentIdentity(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *id)
	}
	return out, rows.Err()
}

// dbDeleteAgentIdentity drops the identity and every session riding on it, so
// deleting a test user immediately stops any browser still holding its cookie.
func dbDeleteAgentIdentity(label, workspace string) error {
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	if _, err := db.Exec(`DELETE FROM agent_sessions WHERE label = ? AND workspace = ?`, label, workspace); err != nil {
		return err
	}
	_, err = db.Exec(`DELETE FROM agent_identities WHERE label = ? AND workspace = ?`, label, workspace)
	return err
}

func hashAgentToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func randomAgentToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// agentCookieValueFor derives a session's cookie value from its hand-over token.
//
// Derived rather than stored so the gate can hand a browser the cookie when it
// arrives with a sign-in URL, without keeping a recoverable copy of the cookie
// anywhere. It is a one-way function of a token that already opens the session,
// so deriving it gives an attacker nothing they did not already have.
func agentCookieValueFor(handover string) string {
	return hashAgentToken(handover + "|cookie")
}

// dbCreateAgentSession mints a session for one identity on one endpoint and
// returns the hand-over token that goes in the sign-in URL, plus the cookie
// value derived from it. Only hashes are persisted.
func dbCreateAgentSession(label, endpointHost, workspace string, ttl time.Duration) (token, handover string, s *agentSession, err error) {
	db, err := openBaileyDB()
	if err != nil {
		return "", "", nil, err
	}
	if handover, err = randomAgentToken(); err != nil {
		return "", "", nil, err
	}
	token = agentCookieValueFor(handover)
	now := time.Now().UTC()
	exp := now.Add(ttl)
	if _, err := db.Exec(
		`INSERT INTO agent_sessions(token_hash, label, endpoint_host, workspace, created_at, expires_at, handover_hash)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		hashAgentToken(token), label, strings.ToLower(endpointHost), workspace,
		now.Format(time.RFC3339), exp.Format(time.RFC3339), hashAgentToken(handover),
	); err != nil {
		return "", "", nil, err
	}
	return token, handover, &agentSession{
		Label:        label,
		EndpointHost: strings.ToLower(endpointHost),
		Workspace:    workspace,
		ExpiresAt:    exp,
	}, nil
}

// dbLookupAgentSession resolves a raw cookie value to its session, or nil when
// the token is unknown or has expired. Expiry is enforced here rather than by a
// sweep, so a lapsed row can never authenticate even if it is still on disk.
func dbLookupAgentSession(token string) (*agentSession, error) {
	return lookupAgentSessionBy("token_hash", token)
}

// dbLookupAgentHandover is the same lookup for the token carried in a sign-in
// URL. It returns the session so the gate can hand the browser the cookie.
func dbLookupAgentHandover(token string) (*agentSession, error) {
	return lookupAgentSessionBy("handover_hash", token)
}

func lookupAgentSessionBy(column, token string) (*agentSession, error) {
	if strings.TrimSpace(token) == "" {
		return nil, nil
	}
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	var (
		s   agentSession
		exp string
	)
	row := db.QueryRow(
		`SELECT label, endpoint_host, workspace, expires_at, COALESCE(token_hash,'')
		   FROM agent_sessions WHERE `+column+` = ?`,
		hashAgentToken(token),
	)
	if err := row.Scan(&s.Label, &s.EndpointHost, &s.Workspace, &exp, &s.TokenHash); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	s.ExpiresAt, err = time.Parse(time.RFC3339, exp)
	if err != nil {
		return nil, fmt.Errorf("stored agent session expiry is corrupt: %w", err)
	}
	if time.Now().UTC().After(s.ExpiresAt) {
		return nil, nil
	}
	return &s, nil
}

// dbDeleteAgentSessionsForEndpoint drops every session for one endpoint, which
// is what un-deploying or deleting that endpoint must do.
func dbDeleteAgentSessionsForEndpoint(endpointHost string) error {
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	_, err = db.Exec(`DELETE FROM agent_sessions WHERE endpoint_host = ?`, strings.ToLower(endpointHost))
	return err
}
