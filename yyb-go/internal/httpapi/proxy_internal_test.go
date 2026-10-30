package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestInternalProxyCredentialsAreLocalAndBearerOnly(t *testing.T) {
	a, _ := healthTestApp(t)
	previous := ApiToken
	ApiToken = "fixture-local-service"
	t.Cleanup(func() { ApiToken = previous })
	profile, err := a.db.UpsertProxyProfile(context.Background(), 0, "Fixture", "socks5", "127.0.0.1", 1080, "test", "private", false, 1000, false)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]int64{"proxy_profile_id": profile.ID})
	for _, tc := range []struct {
		addr, token string
		status      int
	}{
		{"192.0.2.10:1234", ApiToken, 403}, {"127.0.0.1:1234", "wrong", 401}, {"127.0.0.1:1234", ApiToken, 200},
	} {
		req := httptest.NewRequest(http.MethodPost, "/internal/proxy-url", strings.NewReader(string(payload)))
		req.RemoteAddr = tc.addr
		req.Header.Set("Authorization", "Bearer "+tc.token)
		req.Header.Set("X-Farm-Role", "admin")
		req.Header.Set("X-Farm-User-ID", "1000")
		res := httptest.NewRecorder()
		a.Handler().ServeHTTP(res, req)
		if res.Code != tc.status {
			t.Fatalf("status=%d, want %d", res.Code, tc.status)
		}
		if tc.status != 200 && strings.Contains(res.Body.String(), "private") {
			t.Fatal("credential exposure")
		}
		if res.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("response can be cached")
		}
	}
}
