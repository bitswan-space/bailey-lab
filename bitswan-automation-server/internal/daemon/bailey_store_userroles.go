package daemon

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// CRUD on the user_roles table — per-user roles managed locally (see the
// schema comment). The role is the authoritative source for what a person is
// and whether they have the admin capability; it is never read from SSO.

// dbGetUserRole returns the stored role for email, or "" if none is set.
func dbGetUserRole(email string) (string, error) {
	email = strings.TrimSpace(email)
	if email == "" {
		return "", nil
	}
	db, err := openBaileyDB()
	if err != nil {
		return "", err
	}
	var role string
	err = db.QueryRow(`SELECT role FROM user_roles WHERE email = ? COLLATE NOCASE`, email).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("get user role %q: %w", email, err)
	}
	return role, nil
}

// dbListUsersByRoles returns the emails explicitly assigned any of the given
// roles in user_roles, each with its role, sorted by email. (Does NOT include
// the bootstrap root admin, who may have no explicit row — callers that want
// the full auditor/admin set add serverRootAdmin themselves.)
func dbListUsersByRoles(roles ...string) ([]userRole, error) {
	if len(roles) == 0 {
		return nil, nil
	}
	db, err := openBaileyDB()
	if err != nil {
		return nil, err
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(roles)), ",")
	args := make([]any, len(roles))
	for i, r := range roles {
		args[i] = r
	}
	rows, err := db.Query(
		`SELECT email, role FROM user_roles WHERE role IN (`+placeholders+
			`) ORDER BY email COLLATE NOCASE`, args...)
	if err != nil {
		return nil, fmt.Errorf("list users by roles: %w", err)
	}
	defer rows.Close()
	var out []userRole
	for rows.Next() {
		var ur userRole
		if err := rows.Scan(&ur.Email, &ur.Role); err != nil {
			return nil, fmt.Errorf("scan user role: %w", err)
		}
		out = append(out, ur)
	}
	return out, rows.Err()
}

// userRole is one {email, role} pair from the user_roles store.
type userRole struct {
	Email string `json:"email"`
	Role  string `json:"role"`
}

// dbSetUserRole upserts a user's role.
func dbSetUserRole(email, role, by string) error {
	email = strings.TrimSpace(email)
	if email == "" {
		return fmt.Errorf("email required")
	}
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	_, err = db.Exec(
		`INSERT INTO user_roles(email, role, updated_at, updated_by) VALUES (?, ?, ?, ?)
		 ON CONFLICT(email) DO UPDATE SET role=excluded.role, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
		email, role, time.Now().UTC().Format(time.RFC3339), by)
	if err != nil {
		return fmt.Errorf("set user role %q: %w", email, err)
	}
	return nil
}

// dbDeleteUserRole removes a user's stored role (reverting them to the default
// resolution in effectiveRole). Used by tests and by an admin clearing an
// explicit role override.
func dbDeleteUserRole(email string) error {
	email = strings.TrimSpace(email)
	if email == "" {
		return nil
	}
	db, err := openBaileyDB()
	if err != nil {
		return err
	}
	_, err = db.Exec(`DELETE FROM user_roles WHERE email = ? COLLATE NOCASE`, email)
	if err != nil {
		return fmt.Errorf("delete user role %q: %w", email, err)
	}
	return nil
}
