package backup

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Retention is the restic forget policy applied after each run, per
// (workspace × service × stage) series — same numbers gitops used.
type Retention struct {
	Daily   int `json:"daily"`
	Monthly int `json:"monthly"`
}

// Config is the operator-editable backup configuration. Absent config file
// means "enabled with defaults" once the server is AOC-registered — the same
// self-enable semantics gitops had (an explicit enabled:false is the only
// off switch).
type Config struct {
	Enabled   bool      `json:"enabled"`
	Retention Retention `json:"retention"`
}

// DefaultRetention: 30 nightly + 12 monthly, per series.
var DefaultRetention = Retention{Daily: 30, Monthly: 12}

func DefaultConfig() Config {
	return Config{Enabled: true, Retention: DefaultRetention}
}

// Dir is the daemon-side backup state directory (config, key, staging,
// last-run). Lives beside — not inside — workspaces/, so backup runs never
// capture their own staging area.
func Dir() string {
	return filepath.Join(os.Getenv("HOME"), ".config", "bitswan", "backup")
}

func configPath() string  { return filepath.Join(Dir(), "config.json") }
func lastRunPath() string { return filepath.Join(Dir(), "last_run.json") }

func ensureDir() error {
	return os.MkdirAll(Dir(), 0o700)
}

// LoadConfig returns the stored config and whether a config file existed.
// No file yields the enabled defaults (self-enable semantics).
func LoadConfig() (Config, bool, error) {
	data, err := os.ReadFile(configPath())
	if os.IsNotExist(err) {
		return DefaultConfig(), false, nil
	}
	if err != nil {
		return DefaultConfig(), false, err
	}
	cfg := DefaultConfig()
	if err := json.Unmarshal(data, &cfg); err != nil {
		return DefaultConfig(), false, fmt.Errorf("failed to parse %s: %w", configPath(), err)
	}
	if cfg.Retention.Daily <= 0 {
		cfg.Retention.Daily = DefaultRetention.Daily
	}
	if cfg.Retention.Monthly <= 0 {
		cfg.Retention.Monthly = DefaultRetention.Monthly
	}
	return cfg, true, nil
}

// SaveConfig persists the config (0600 — it is not secret, but it lives in
// the key's directory and there is no reason to be laxer).
func SaveConfig(cfg Config) error {
	if err := ensureDir(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configPath(), data, 0o600)
}
