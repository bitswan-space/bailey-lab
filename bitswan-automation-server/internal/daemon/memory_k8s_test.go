package daemon

import "testing"

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
		{"", 0},
		{"lots", 0},
		{"4Gib", 0},
	} {
		if got := parseNamespaceQuantity(tc.in); got != tc.want {
			t.Errorf("%q read as %d, want %d", tc.in, got, tc.want)
		}
	}
}

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

	total, avail, warning = budgetFromQuota(1<<30, []memContainer{
		{Running: true, ReservationMB: 256},
		{Running: false, ReservationMB: 256},
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

	if _, avail, _ = budgetFromQuota(1<<20, []memContainer{{Running: true, ReservationMB: 64}}); avail != 0 {
		t.Errorf("over-reserved reported %d free", avail)
	}
}
