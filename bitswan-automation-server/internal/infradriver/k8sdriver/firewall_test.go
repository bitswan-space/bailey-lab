package k8sdriver

import "testing"

func TestPeerAddressesRollTheWorkloadWhenAPeerMoves(t *testing.T) {
	peers := []string{"ws-postgres-dev", "ws-garage-dev"}

	before := peerAddresses(peers, map[string]string{
		"ws-postgres-dev": "10.43.0.7",
		"ws-garage-dev":   "10.43.0.9",
	})
	if before == "" {
		t.Fatal("resolved peers produced no pin, so a moved peer could never roll the workload")
	}
	if same := peerAddresses(peers, map[string]string{
		"ws-garage-dev":   "10.43.0.9",
		"ws-postgres-dev": "10.43.0.7",
	}); same != before {
		t.Errorf("map order changed the pin (%q vs %q); every apply would roll every workload", same, before)
	}
	if moved := peerAddresses(peers, map[string]string{
		"ws-postgres-dev": "10.43.0.7",
		"ws-garage-dev":   "10.43.1.4",
	}); moved == before {
		t.Error("a peer at a new address produced the same pin; the workload would keep rules that block it")
	}
	if unrelated := peerAddresses(peers, map[string]string{
		"ws-postgres-dev": "10.43.0.7",
		"ws-garage-dev":   "10.43.0.9",
		"something-else":  "10.43.2.2",
	}); unrelated != before {
		t.Error("a service this workload does not peer with changed its pin")
	}
	if none := peerAddresses(peers, nil); none != "" {
		t.Errorf("no cluster reading produced a pin %q; a compile with no cluster to ask must stay pure", none)
	}
}
