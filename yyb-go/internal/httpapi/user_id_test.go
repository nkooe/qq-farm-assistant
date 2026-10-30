package httpapi

import (
	"net/http/httptest"
	"testing"
)

func TestCallerRequiresCanonicalIDAndMatchingRole(t *testing.T) {
	for _, tc := range []struct{ role, id string }{{"admin", "1001"}, {"user", "1000"}, {"admin", "01000"}, {"admin", "+1000"}, {"admin", "1000x"}, {"user", "999"}, {"admin", ""}, {"user", "9007199254740992"}} {
		req := httptest.NewRequest("GET", "/accounts", nil)
		req.Header.Set("X-Farm-Role", tc.role)
		req.Header.Set("X-Farm-User-ID", tc.id)
		req.Header.Set("X-Farm-User", "admin")
		role, id := proxyCaller(req)
		if role != "" || id != 0 {
			t.Fatal("invalid caller accepted", tc)
		}
	}
}
