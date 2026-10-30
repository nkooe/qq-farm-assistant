package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"yyb_go/internal/qr"
)

func TestUserPurgeWaitsForRequestsAndRetainsRowsUntilFilesAreRemoved(t *testing.T) {
	a, _ := healthTestApp(t)
	previous := ApiToken
	ApiToken = "fixture-purge-token"
	t.Cleanup(func() { ApiToken = previous })
	ctx := context.Background()
	alice, err := a.db.UpsertAccount(ctx, "alice-openid", "buffer", 1001, "user", nil, nil, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	bob, err := a.db.UpsertAccount(ctx, "bob-openid", "buffer", 1002, "user", nil, nil, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	avatar := a.resources.avatarPath(alice.OwnerUserID, alice.OpenID)
	// A nonempty directory causes a real, portable removal failure.
	if err := os.Mkdir(avatar, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(avatar, "locked"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(a.resources.avatarPath(bob.OwnerUserID, bob.OpenID), []byte("bob"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, owner := range []string{"alice", "bob"} {
		id := owner + "-session"
		a.qrSessions[id] = &qr.Session{ID: id, OwnerUserID: map[string]int64{"alice": 1001, "bob": 1002}[owner], OwnerRole: "user", CreatedAt: time.Now()}
		if err := os.WriteFile(a.resources.qrPath(id), []byte(owner), 0600); err != nil {
			t.Fatal(err)
		}
	}
	purge := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodDelete, "/internal/users", strings.NewReader(`{"userId":1001}`))
		req.RemoteAddr = "127.0.0.1:1234"
		req.Header.Set("Authorization", "Bearer "+ApiToken)
		req.Header.Set("X-Farm-Role", "admin")
		req.Header.Set("X-Farm-User-ID", "1000")
		res := httptest.NewRecorder()
		a.Handler().ServeHTTP(res, req)
		return res
	}
	if res := purge(); res.Code != 500 {
		t.Fatalf("status=%d body=%s", res.Code, res.Body)
	}
	if _, err := a.db.GetAccount(ctx, alice.ID); err != nil {
		t.Fatal("failed purge lost retry identity:", err)
	}
	if err := os.RemoveAll(avatar); err != nil {
		t.Fatal(err)
	}
	a.userDataMu.RLock()
	started := make(chan struct{})
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { close(started); done <- purge() }()
	<-started
	select {
	case <-done:
		a.userDataMu.RUnlock()
		t.Fatal("purge did not wait for active requests")
	case <-time.After(30 * time.Millisecond):
	}
	a.userDataMu.RUnlock()
	res := <-done
	if res.Code != 200 {
		t.Fatalf("status=%d body=%s", res.Code, res.Body)
	}
	if _, err := a.db.GetAccount(ctx, alice.ID); err == nil {
		t.Fatal("account survived purge")
	}
	if _, err := a.db.GetAccount(ctx, bob.ID); err != nil {
		t.Fatal("other user lost account:", err)
	}
	if _, err := os.Stat(a.resources.qrPath("alice-session")); !os.IsNotExist(err) {
		t.Fatal("QR survived purge:", err)
	}
	if _, err := os.Stat(a.resources.qrPath("bob-session")); err != nil {
		t.Fatal("other user lost QR:", err)
	}
	if _, err := os.Stat(a.resources.avatarPath(bob.OwnerUserID, bob.OpenID)); err != nil {
		t.Fatal("other user lost avatar:", err)
	}
	if a.getQRSession("alice-session") != nil || a.getQRSession("bob-session") == nil {
		t.Fatal("QR ownership cleanup failed")
	}
}
