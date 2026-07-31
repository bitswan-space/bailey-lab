package daemon

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/pquerna/otp/totp"

	"github.com/bitswan-space/bitswan-workspaces/internal/aoc"
)

// Per-workspace identity for the coding agent, so the agent can browse
// the apps it edits through the SAME path a user takes: the public
// hostname, oauth2-proxy, a real Keycloak login, and Bailey's device
// trust. Reaching an app by its internal address would be easier and
// would defeat the purpose — the agent would stop experiencing the bugs
// the user experiences.
//
// Three things have to exist before the agent container starts:
//
//  1. a Keycloak bot account (minted by the AOC, which derives the
//     address and holds it to plain org-member rights);
//  2. a TOTP secret for that account in this daemon's MFA store, seeded
//     server-side — Bailey's device trust is mandatory and unconditional,
//     and POST /bailey/api/self-trust with a valid code is the only path
//     to it that needs no human admin;
//  3. both, plus the password, written where the agent can read them.
//
// On the 2FA question this deliberately raises: the bot holds both of its
// own factors inside its own container, so device trust for the bot is a
// bookkeeping step rather than a second factor. That is the honest
// trade-off of an unattended agent, and it is acceptable only because the
// account is a plain org member — no admin or auditor group, which are
// what the protected gate actually reads out of the group_membership
// claim. Anyone widening the bot's group membership invalidates this
// reasoning. The alternative, an admin approving each agent device by
// hand, is what "unattended" rules out.
//
// REVISIT — this design assumes TOTP stays available as a device-trust
// factor. That is a real assumption, not a safe one: TOTP may be turned
// off for some deployments or use-cases later, and if it is, this whole
// path stops working and the agent loses its only unattended route to
// device trust.
//
// Be precise about WHICH TOTP, because two unrelated things share the
// name and only one of them matters here:
//
//   - Keycloak realm 2FA — irrelevant. The bot logs in with a password
//     and nothing in this file touches Keycloak's own OTP config.
//   - Bailey's TOTP store (this daemon's totp_records table, consumed by
//     /bailey/api/self-trust) — load-bearing. This is the one that must
//     keep existing.
//
// So the failure mode to watch for is an operator or a future release
// disabling Bailey-side TOTP or self-trust, not a realm-level 2FA policy
// change. When that happens, seeding a secret still "succeeds" here while
// self-trust starts rejecting the code, and the agent fails at device
// trust with no obvious connection back to this decision.
//
// If it comes to that, the options are roughly: a first-class
// "service account" device-trust grant that the daemon can issue for
// accounts it provisioned itself (auditable, no shared factor, but a new
// trust path to review); or accepting that agent browsing needs a
// one-time human device approval per workspace, which gives up
// unattended provisioning. Neither is a small change, which is the
// argument for deciding it deliberately rather than discovering it.

// agentCredentialsFile is the name of the credentials file dropped into
// the agent's home directory.
const agentCredentialsFile = ".bitswan-agent-account.json"

// agentAccountClient is the slice of the AOC client this file needs.
// Named as an interface, and reached through a package-level constructor
// variable, so the provisioning logic can be tested without an AOC to
// talk to.
type agentAccountClient interface {
	EnsureAgentAccount(workspaceName string) (*aoc.AgentAccountResponse, error)
	DeleteAgentAccount(workspaceName string) error
}

var newAgentAccountClient = func() (agentAccountClient, error) {
	return aoc.NewAOCClient()
}

// chownAgentFile is indirected for the same reason: the real
// implementation may shell out to sudo, which a test must not do.
var chownAgentFile = chownAgentPath

// agentAccountCredentials is what the agent reads to log itself in. The
// TOTP secret is the seed for the code the agent posts to
// /bailey/api/self-trust to get its browser trusted.
type agentAccountCredentials struct {
	Email      string `json:"email"`
	Password   string `json:"password"`
	TOTPSecret string `json:"totp_secret"`
	// SelfTrustPath is recorded rather than hardcoded agent-side so the
	// route can move without shipping a new agent image.
	SelfTrustPath string `json:"self_trust_path"`
	// LoginURL is where the agent performs its one interactive login.
	//
	// It MUST sit on the protected domain, because that is the domain the
	// device-trust cookie is scoped to (cookieDomainForProtected returns
	// ".<protected-domain>"). Log in anywhere else and the cookie the gate
	// sets will not be sent to the apps the agent needs to reach.
	//
	// Computed here because only the daemon knows the answer: the
	// protected domain can be overridden per deployment
	// (ProtectedHostnameDomain prefers ProtectedDomain over the
	// AOC-assigned domain), so the agent cannot derive it. Empty when the
	// server has no usable public domain, which the agent treats as "no
	// browsing identity available" rather than guessing.
	LoginURL string `json:"login_url"`
}

// provisionAgentIdentity mints (or rotates) the coding-agent account for
// a workspace, seeds its TOTP secret in the local MFA store, and writes
// the credentials into the agent's home directory.
//
// Call it AFTER the agent's compose file is written and BEFORE the
// container is started, so the credentials are in place the first time
// the agent looks for them.
//
// Retry policy lives here rather than in the AOC client: this makes ONE
// attempt and never loops. Two reasons. A permanent rejection
// (unknown_workspace, ensure_failed) cannot clear without someone
// intervening, so a loop would only burn requests. And the AOC's throttle
// on this endpoint is keyed per automation SERVER, not per workspace — so
// a loop spending that budget on a doomed request would deny agent
// provisioning to every OTHER workspace on this server. A 429 is feedback
// about our own call rate and carries no information about whether the
// request was valid, so it must never be what drives a retry decision.
func provisionAgentIdentity(workspaceName, workspacePath string) error {
	aocClient, err := newAgentAccountClient()
	if err != nil {
		return fmt.Errorf("failed to create AOC client: %w", err)
	}

	account, err := aocClient.EnsureAgentAccount(workspaceName)
	if err != nil {
		return fmt.Errorf("failed to get coding-agent account from AOC: %w", err)
	}

	// Seed the second factor ourselves. The bot cannot complete an
	// interactive enrolment (nobody scans a QR code for it), and
	// dbSaveTOTP is a plain upsert — so seeding needs no new bypass in
	// the MFA gate, which is the property that made this design
	// preferable to a self-trust exemption.
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      totpIssuerName(),
		AccountName: account.Email,
	})
	if err != nil {
		return fmt.Errorf("failed to generate TOTP secret for %s: %w", account.Email, err)
	}
	if err := dbSaveTOTP(&totpRecord{
		Email:     account.Email,
		Secret:    key.Secret(),
		CreatedAt: nowRFC3339(),
	}); err != nil {
		return fmt.Errorf("failed to store TOTP secret for %s: %w", account.Email, err)
	}

	creds := agentAccountCredentials{
		Email:         account.Email,
		Password:      account.Password,
		TOTPSecret:    key.Secret(),
		SelfTrustPath: "/bailey/api/self-trust",
		LoginURL:      agentLoginURL(),
	}
	if err := writeAgentCredentials(workspacePath, creds); err != nil {
		return err
	}

	// Authorize the identity we just created. Non-fatal on purpose: the
	// account, its second factor and its credentials file are all in place by
	// now, so the bot IS provisioned — only its app authorization is missing,
	// and that is one command to repair:
	//   bitswan bailey access grant <workspace-dashboard-host> <email>
	// Returning an error here would report a failed provisioning for a bot
	// that works, and would re-mint the account on the next attempt.
	if err := grantAgentWorkspaceAccess(workspaceName, account.Email); err != nil {
		fmt.Printf("WARNING: coding agent %s cannot open workspace apps yet: %v\n", account.Email, err)
	}

	action := "rotated"
	if account.Created {
		action = "created"
	}
	fmt.Printf("Coding agent account %s for workspace '%s' (%s)\n", action, workspaceName, account.Email)
	return nil
}

// grantAgentWorkspaceAccess gives the bot the least-privileged `access`
// role on the workspace's DASHBOARD endpoint — deliberately not on the
// individual apps.
//
// Bailey has two independent authorization layers, and the account alone
// only satisfies the first: org membership admits the bot to the LOGIN,
// while the endpoint ACL decides which apps it may OPEN. Without a grant the
// bot authenticates perfectly and then gets 403 "Access required" on every
// app (enforceEndpointACL).
//
// One grant covers the whole workspace because roleFor delegates a child
// endpoint's membership to its parent, and every workspace-spawned route
// sets parent = the workspace dashboard (see ingress.go). So this also
// covers apps deployed AFTER provisioning, which a per-app grant could not
// do without a hook in the deploy path plus a backfill.
//
// The role is always `access`, never `owner`. Owner can manage sharing and
// nothing about browsing needs that, and delegation can only widen
// access→access, never upgrade to owner (roleFor). The bot's reach is capped
// at "can open pages".
//
// Scoping is by construction: this workspace's bot gets a role on this
// workspace's dashboard only, so it cannot reach another workspace's apps
// through the gate.
func grantAgentWorkspaceAccess(workspaceName, email string) error {
	host := workspaceDashboardEndpoint(workspaceName)
	if host == "" {
		return fmt.Errorf("workspace '%s' has no dashboard endpoint to hang the grant on", workspaceName)
	}
	// endpoint_grants has a FOREIGN KEY to endpoints(hostname) and the daemon
	// opens the DB with foreign_keys(on) (bailey_store.go), so the dashboard
	// endpoint must already be registered — the grant cannot be pre-created.
	// On an existing workspace it is registered long before the coding agent
	// is enabled; during a fresh init the dashboard route may register later,
	// which is why registerWorkspaceAgentGrant tops this up at registration
	// time. Checking explicitly turns an opaque FK error into a clear reason.
	ep, err := getEndpoint(host)
	if err != nil {
		return err
	}
	if ep == nil {
		return fmt.Errorf("dashboard endpoint %s is not registered yet", host)
	}
	return addGrant(host, "email", email, string(roleAccess), "daemon (coding agent)")
}

// registerWorkspaceAgentGrant re-applies the coding agent's dashboard grant
// when a workspace dashboard endpoint is registered.
//
// This exists purely for ordering. grantAgentWorkspaceAccess cannot run
// before the dashboard endpoint row exists (foreign key), and on a fresh
// `workspace init` the coding agent may be provisioned before the dashboard
// route is registered. Calling this from the registration path closes that
// window from the other side, whichever order the two happen in. addGrant is
// INSERT OR IGNORE, so the common case — dashboard long registered, grant
// already applied at provisioning — is a harmless no-op.
//
// The bot's address is read from the workspace's credentials file rather than
// re-derived: the AOC owns that derivation (it includes a digest of the exact
// workspace name), and a locally reconstructed address would silently
// authorize the wrong principal. No credentials file means no coding agent
// for this workspace, so there is nothing to grant.
func registerWorkspaceAgentGrant(workspaceName string) {
	if workspaceName == "" {
		return
	}
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return
	}
	wsPath := filepath.Join(homeDir, ".config", "bitswan", "workspaces", workspaceName)
	creds, err := readAgentCredentials(wsPath)
	if err != nil || creds.Email == "" {
		return
	}
	if err := grantAgentWorkspaceAccess(workspaceName, creds.Email); err != nil {
		fmt.Printf("WARNING: could not grant coding agent %s access on workspace '%s': %v\n",
			creds.Email, workspaceName, err)
	}
}

// revokeAgentWorkspaceAccess removes the grant added by
// grantAgentWorkspaceAccess. A no-op if the dashboard endpoint is already
// gone: endpoint_grants cascades on endpoint deletion.
func revokeAgentWorkspaceAccess(workspaceName, email string) error {
	host := workspaceDashboardEndpoint(workspaceName)
	if host == "" {
		return nil
	}
	return removeGrant(host, "email", email, string(roleAccess))
}

// agentLoginURL returns the Bailey console URL on the protected domain,
// or "" when the server has no usable public domain.
//
// The ".bswn.internal" case is excluded for the same reason
// cookieDomainForProtected excludes it: that suffix means there is no real
// public domain, so no cross-host cookie — and therefore no working
// browsing identity — is possible.
func agentLoginURL() string {
	d := protectedHostnameDomain()
	if d == "" || strings.HasSuffix(d, ".bswn.internal") {
		return ""
	}
	return "https://bailey." + d
}

// writeAgentCredentials writes the credentials file into the workspace's
// coding-agent-home directory, which is bind-mounted at /home/agent in
// the agent container.
func writeAgentCredentials(workspacePath string, creds agentAccountCredentials) error {
	homeDir := filepath.Join(workspacePath, "coding-agent-home")
	if err := os.MkdirAll(homeDir, 0755); err != nil {
		return fmt.Errorf("failed to create coding-agent-home directory: %w", err)
	}
	path := filepath.Join(homeDir, agentCredentialsFile)

	payload, err := json.MarshalIndent(creds, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to encode agent credentials: %w", err)
	}

	// Write to a temp file in the same directory and rename, so the agent
	// can never read a half-written file — a rotation overwrites live
	// credentials while the agent may be running.
	tmp, err := os.CreateTemp(homeDir, ".bitswan-agent-account-*.tmp")
	if err != nil {
		return fmt.Errorf("failed to create temp credentials file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once the rename succeeds

	// 0600 before any content is written: the password and the TOTP seed
	// are both in here, so the file must never exist group/world-readable
	// even briefly.
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return fmt.Errorf("failed to chmod temp credentials file: %w", err)
	}
	if _, err := tmp.Write(payload); err != nil {
		tmp.Close()
		return fmt.Errorf("failed to write temp credentials file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("failed to close temp credentials file: %w", err)
	}

	// The agent runs as uid 1000 inside the container (see Enable's chown
	// of coding-agent-home), so the file has to be owned by 1000 to be
	// readable at mode 0600.
	if runtime.GOOS == "linux" {
		if err := chownAgentFile(tmpName); err != nil {
			return err
		}
	}

	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("failed to install credentials file: %w", err)
	}
	return nil
}

// chownAgentPath gives a path to uid/gid 1000, matching the ownership
// Enable applies to coding-agent-home.
func chownAgentPath(path string) error {
	// Try directly first. This succeeds when running as root and also in
	// the common case where the daemon already runs as uid 1000 — no
	// reason to invoke sudo to hand a file to its existing owner.
	if err := os.Chown(path, 1000, 1000); err == nil {
		return nil
	}
	return sudoChown(path)
}

// sudoChown is the privileged fallback, indirected so tests can cover the
// fallback branch without a sudo on the box. Mirrors what Enable already
// does for coding-agent-home itself.
var sudoChown = func(path string) error {
	cmd := exec.Command("sudo", "chown", "1000:1000", path)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to chown %s: %w: %s", path, err, string(out))
	}
	return nil
}

// deprovisionAgentIdentity removes a workspace's coding-agent account,
// its seeded TOTP record and its credentials file.
//
// Order matters: the AOC account goes first, because that is what an
// attacker could actually use. If that call fails we stop and report,
// leaving the local files in place — deleting the local copy of
// credentials for an account that still exists would destroy the only
// record of what needs cleaning up.
func deprovisionAgentIdentity(workspaceName, workspacePath string) error {
	aocClient, err := newAgentAccountClient()
	if err != nil {
		return fmt.Errorf("failed to create AOC client: %w", err)
	}

	// Read the email before deleting anything: it is the key to the local
	// TOTP record, and it is the AOC's derived address, which must not be
	// reconstructed locally.
	email := ""
	if creds, err := readAgentCredentials(workspacePath); err == nil {
		email = creds.Email
	}

	if err := aocClient.DeleteAgentAccount(workspaceName); err != nil {
		return fmt.Errorf("failed to delete coding-agent account for workspace '%s': %w", workspaceName, err)
	}

	if email != "" {
		if err := dbDeleteTOTP(email); err != nil {
			return fmt.Errorf("failed to delete TOTP record for %s: %w", email, err)
		}
		// Non-fatal: a leftover grant on a deleted account authorizes nobody
		// (the account is gone from Keycloak, so no login can present that
		// email), and failing here would leave the credentials file behind —
		// the only record of what still needs cleaning up.
		if err := revokeAgentWorkspaceAccess(workspaceName, email); err != nil {
			fmt.Printf("WARNING: failed to revoke coding-agent access grant for %s: %v\n", email, err)
		}
	}

	path := filepath.Join(workspacePath, "coding-agent-home", agentCredentialsFile)
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to remove agent credentials file: %w", err)
	}
	return nil
}

// readAgentCredentials loads the credentials file for a workspace.
func readAgentCredentials(workspacePath string) (*agentAccountCredentials, error) {
	path := filepath.Join(workspacePath, "coding-agent-home", agentCredentialsFile)
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var creds agentAccountCredentials
	if err := json.Unmarshal(raw, &creds); err != nil {
		return nil, fmt.Errorf("failed to decode %s: %w", path, err)
	}
	return &creds, nil
}
