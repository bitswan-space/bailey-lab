package daemon

import (
	"testing"
	"time"
)

func TestUntilNextBackup(t *testing.T) {
	cases := []struct {
		now  string
		want time.Duration
	}{
		{"2026-07-29T01:00:00Z", time.Hour},                     // before the slot → today
		{"2026-07-29T02:00:00Z", 24 * time.Hour},                // exactly on it → tomorrow
		{"2026-07-29T03:30:00Z", 22*time.Hour + 30*time.Minute}, // after → tomorrow
		{"2026-07-29T23:59:00Z", 2*time.Hour + time.Minute},
	}
	for _, tc := range cases {
		now, err := time.Parse(time.RFC3339, tc.now)
		if err != nil {
			t.Fatal(err)
		}
		if got := untilNextBackup(now); got != tc.want {
			t.Errorf("untilNextBackup(%s) = %v, want %v", tc.now, got, tc.want)
		}
	}
}
