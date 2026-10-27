package protocol

import "testing"

func TestOrderLonglinkTargetsKeepsPortsForSameIPAndPrefers443(t *testing.T) {
	targets := []Target{
		{IP: "203.0.113.8", Port: 8080},
		{IP: "203.0.113.8", Port: 443},
		{IP: "203.0.113.8", Port: 80},
	}

	got := orderLonglinkTargets(targets, 6)
	if len(got) != 3 {
		t.Fatalf("orderLonglinkTargets() returned %d candidates, want 3: %#v", len(got), got)
	}
	if got[0].Port != 443 {
		t.Fatalf("first candidate port = %d, want 443", got[0].Port)
	}
}
