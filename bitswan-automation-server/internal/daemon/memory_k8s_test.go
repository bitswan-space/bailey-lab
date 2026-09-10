package daemon

import "testing"

// TestAQuantityIsReadOrRefused covers the parsing the budget rests on. A
// misread quota is worse than no quota: it becomes a ceiling nobody set, and
// the governor admits workloads against it until the real limit kills them.
func TestAQuantityIsReadOrRefused(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want int64
	}{
		{"4Gi", 4 << 30},
		{"512Mi", 512 << 20},
		{"2G", 2000 * 1000 * 1000},
		{"1024", 1024},
		{" 8Gi ", 8 << 30},
		// Unrecognised is zero, which the caller reads as "no ceiling" — never
		// as a number this made up.
		{"", 0},
		{"lots", 0},
		{"4Gib", 0},
	} {
		if got := parseNamespaceQuantity(tc.in); got != tc.want {
			t.Errorf("%q read as %d, want %d", tc.in, got, tc.want)
		}
	}
}

// TestNoQuotaIsSaidNotGuessed is the property that keeps a namespace from
// believing it owns the node. Reading /proc/meminfo in a pod reports the
// node's memory, so a Bailey with a 4 GB quota on a 256 GB node would admit
// workloads until the quota killed them. With no quota there is no ceiling to
// report, and the operator is told so.
func TestNoQuotaIsSaidNotGuessed(t *testing.T) {
	total, avail, warning := budgetFromQuota(0, []memContainer{
		{Running: true, ReservationMB: 512},
	})
	if total != 0 || avail != 0 {
		t.Errorf("invented a budget of %d/%d from no quota", total, avail)
	}
	if warning == "" {
		t.Error("no quota and no warning; the page would show an empty budget with no reason")
	}

	// With a quota, what is free is the ceiling minus what is reserved against
	// it — there is no measured "available" for a namespace.
	total, avail, warning = budgetFromQuota(1<<30, []memContainer{
		{Running: true, ReservationMB: 256},
		{Running: false, ReservationMB: 256}, // not running, not claimed
	})
	if total != 1<<30 {
		t.Errorf("total = %d, want the quota", total)
	}
	if avail != 1<<30-256*1024*1024 {
		t.Errorf("available = %d, want the quota less the running reservation", avail)
	}
	if warning != "" {
		t.Errorf("warned despite a quota: %s", warning)
	}

	// Over-reserved clamps rather than underflowing an unsigned subtraction
	// into an enormous free figure.
	if _, avail, _ = budgetFromQuota(1<<20, []memContainer{{Running: true, ReservationMB: 64}}); avail != 0 {
		t.Errorf("over-reserved reported %d free", avail)
	}
}
