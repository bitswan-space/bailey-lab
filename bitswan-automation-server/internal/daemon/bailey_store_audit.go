package daemon

import "time"

// CRUD on the events table — the append-only security audit log that
// backs the Server Console overview's recent-activity feed. There is no
// equivalent in #340 (its bailey_notifications.go surfaces live pending
// state, not a persistent history), so this is a new, minimal store:
// append on mutation, read back newest-first for the feed.

// Stable action verbs. Centralised so call sites can't drift on
// spelling and the frontend can switch on a known set.
const (
	auditDeviceApprove   = "device.approve"   // a device became trusted (pair-approve, self-trust, or claim TOFU)
	auditDeviceRevoke    = "device.revoke"    // a device was removed (self-service or admin)
	auditWorkspaceCreate = "workspace.create" // a workspace was provisioned
	auditWorkspaceTrash  = "workspace.trash"  // a workspace was moved to trash
	auditServerClaim     = "server.claim"     // the one-time root-admin bootstrap ran
	auditTOTPEnrol       = "totp.enrol"       // a user enrolled an authenticator secret
	auditInviteCreate    = "invite.create"    // an admin invited an AOC-org member
	auditInviteResend    = "invite.resend"    // an admin re-sent an invite (fresh token + expiry)
	auditInviteRevoke    = "invite.revoke"    // an admin revoked an outstanding invite
	auditInviteRedeem    = "invite.redeem"    // an invitee redeemed their invite (first device trusted)
)

// eventRecord is one audit row, JSON-shaped for the overview feed.
type eventRecord struct {
	TS     string `json:"ts"`     // RFC3339 UTC
	Actor  string `json:"actor"`  // email that performed the action ("" = system)
	Action string `json:"action"` // one of the audit* verbs
	Target string `json:"target"` // device id, workspace name, or affected email
}

// recordEvent appends one audit row. Best-effort by design: a failure
// to write the audit log must never block or fail the underlying
// mutation (the mutation is the thing that matters; the log is
// secondary), so callers ignore the returned error. We still return it
// so a caller that wants to log the failure can.
func recordEvent(actor, action, target string) error {
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	ts := time.Now().UTC().Format(time.RFC3339)
	_, err = db.Exec(
		`INSERT INTO events(ts, actor, action, target) VALUES (?, ?, ?, ?)`,
		ts, actor, action, target)
	// Mirror the event to the configured SIEM ingestor (OpenTelemetry). This
	// is best-effort and asynchronous, so it never blocks or fails the audit
	// write — same contract as the recordEvent caller relies on.
	siemForwardEvent(eventRecord{TS: ts, Actor: actor, Action: action, Target: target})
	return err
}

// dbListEvents returns the most recent audit rows, newest first, capped
// at limit. All rows are read into a slice before returning — never call
// another DB helper inside the rows loop (see openBaileyDB on why).
func dbListEvents(limit int) ([]eventRecord, error) {
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 25
	}
	rows, err := db.Query(
		`SELECT ts, actor, action, target FROM events ORDER BY ts DESC, rowid DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []eventRecord{}
	for rows.Next() {
		var e eventRecord
		if err := rows.Scan(&e.TS, &e.Actor, &e.Action, &e.Target); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
