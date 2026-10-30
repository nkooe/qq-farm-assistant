package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"yyb_go/internal/qr"
)

func idText(id int64) string { return strconv.FormatInt(id, 10) }

func TestProxyOwnershipSharingAndRedaction(t *testing.T) {
	a, _ := healthTestApp(t)
	previous := ApiToken
	ApiToken = "fixture-isolation-token"
	t.Cleanup(func() { ApiToken = previous })
	handler := a.Handler()
	request := func(method, path, role, username, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:1234"
		req.Header.Set("Authorization", "Bearer "+ApiToken)
		req.Header.Set("X-Farm-Role", role)
		req.Header.Set("X-Farm-User-ID", map[string]string{"root": "1000", "alice": "1001", "bob": "1002"}[username])
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		return res
	}
	create := func(name, role, user string, shared bool) int64 {
		body, _ := json.Marshal(map[string]any{"name": name, "protocol": "socks5", "host": "192.0.2.55", "port": 1080, "username": "fixture-proxy-login", "password": "fixture-proxy-secret", "shared_with_users": shared})
		res := request("POST", "/proxy-profiles", role, user, string(body))
		if res.Code != 201 {
			t.Fatalf("create status=%d: %s", res.Code, res.Body)
		}
		var data struct {
			Data struct {
				ID int64 `json:"id"`
			} `json:"data"`
		}
		if err := json.Unmarshal(res.Body.Bytes(), &data); err != nil {
			t.Fatal(err)
		}
		return data.Data.ID
	}
	private := create("admin-private", "admin", "root", false)
	shared := create("admin-shared", "admin", "root", true)
	alice := create("my-proxy", "user", "alice", true) // User cannot publish a proxy.
	bob := create("my-proxy", "user", "bob", false)    // Same name in another namespace.
	res := request("GET", "/proxy-profiles", "user", "alice", "")
	var listed struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if res.Code != 200 || len(listed.Data) != 2 {
		t.Fatalf("unexpected list: %s", res.Body)
	}
	for _, row := range listed.Data {
		switch int64(row["id"].(float64)) {
		case shared:
			if len(row) != 3 || row["name"] != "admin-shared" || row["redacted"] != true {
				t.Fatalf("shared proxy leaked fields: %#v", row)
			}
		case alice:
			if row["host"] != "192.0.2.55" || row["shared_with_users"] == true {
				t.Fatalf("own proxy not editable/private: %#v", row)
			}
		default:
			t.Fatal("another owner's proxy was listed")
		}
	}
	for _, id := range []int64{private, shared, bob} {
		body, _ := json.Marshal(map[string]any{"id": id, "name": "tampered", "protocol": "socks5", "host": "192.0.2.1", "port": 1080})
		if got := request("PUT", "/proxy-profiles", "user", "alice", string(body)); got.Code != 403 {
			t.Fatalf("cross-owner edit status=%d", got.Code)
		}
		if got := request("DELETE", "/proxy-profiles?id="+idText(id), "user", "alice", ""); got.Code != 403 {
			t.Fatalf("cross-owner delete status=%d", got.Code)
		}
	}
	for _, tc := range []struct {
		id     int64
		status int
	}{{alice, 200}, {shared, 200}, {bob, 400}, {private, 400}} {
		body, _ := json.Marshal(map[string]any{"proxy_profile_id": tc.id})
		got := request("POST", "/internal/proxy-url", "user", "alice", string(body))
		if got.Code != tc.status {
			t.Fatalf("resolve %d status=%d", tc.id, got.Code)
		}
	}
	profile, err := a.db.GetProxyProfile(context.Background(), shared)
	if err != nil || profile.OwnerUserID != 1000 {
		t.Fatal("admin proxy was assigned to a user")
	}
	body, _ := json.Marshal(map[string]any{"id": shared, "name": profile.Name, "protocol": profile.Protocol, "host": profile.Host, "port": profile.Port, "username": profile.Username, "password": "__KEEP__", "shared_with_users": false})
	if got := request("PUT", "/proxy-profiles", "admin", "root", string(body)); got.Code != 200 {
		t.Fatalf("admin edit status=%d", got.Code)
	}
	profile, _ = a.db.GetProxyProfile(context.Background(), shared)
	if profile.SharedWithUsers || profile.Password != "fixture-proxy-secret" {
		t.Fatal("share revocation or password retention failed")
	}
	if got := request("POST", "/internal/proxy-url", "user", "alice", `{"proxy_profile_id":`+idText(shared)+`}`); got.Code != 400 {
		t.Fatal("revoked proxy remained available")
	}
	if got := request("GET", "/proxy-profiles", "admin", "root", ""); got.Code != 200 || !strings.Contains(got.Body.String(), "admin-private") {
		t.Fatal("administrator lost access")
	}
	if got := request("GET", "/proxy-profiles", "user", "", ""); got.Code != 403 {
		t.Fatal("missing identity was accepted")
	}
}

func TestQRSessionOwnershipAndUnauthenticatedToken(t *testing.T) {
	a, _ := healthTestApp(t)
	a.qrSessions["fixture"] = &qr.Session{OwnerUserID: 1001, OwnerRole: "user", CreatedAt: time.Now()}
	for _, tc := range []struct{ action, method string }{{"poll", http.MethodGet}, {"confirm", http.MethodPost}} {
		req := httptest.NewRequest(tc.method, "/qr/fixture/"+tc.action, nil)
		req.Header.Set("X-Farm-User-ID", "1002")
		res := httptest.NewRecorder()
		a.handleQR(res, req)
		if res.Code != 403 {
			t.Fatalf("QR cross-user %s status=%d", tc.action, res.Code)
		}
	}
	res := httptest.NewRecorder()
	a.Handler().ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/token", nil))
	if res.Code != 401 || strings.Contains(res.Body.String(), `"token"`) {
		t.Fatal("unauthenticated service token exposure")
	}
}
