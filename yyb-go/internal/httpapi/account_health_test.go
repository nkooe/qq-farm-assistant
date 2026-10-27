package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"yyb_go/internal/protocol"
	"yyb_go/internal/store"
)

func healthTestApp(t *testing.T) (*App, *store.WechatAccount) {
	t.Helper()
	t.Setenv("YYB_KEEPALIVE_INTERVAL", "0")
	t.Setenv("GIN_MODE", "test")
	a, err := NewApp(Config{ResourceRoot: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.Close() })
	status := "alive"
	acc, err := a.db.UpsertAccount(context.Background(), "wx-test", "secret-buffer", nil, nil, nil, nil,
		protocol.LoginBufferCredentials{OpenID: "wx-test", AccessToken: "secret-access", RefreshToken: "secret-refresh", ExpiresAt: time.Now().Add(time.Hour).Unix()}.ToMap(), &status)
	if err != nil {
		t.Fatal(err)
	}
	return a, acc
}

func TestRefreshNetworkFailurePreservesCredentialsAndSchedulesBackoff(t *testing.T) {
	a, acc := healthTestApp(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for i := 1; i <= 3; i++ {
		status, err := a.recordRefreshFailure(ctx, acc, context.DeadlineExceeded)
		if status != "retry" || err == nil {
			t.Fatalf("status=%s err=%v", status, err)
		}
		h, err := a.db.GetRefreshHealth(context.Background(), acc.ID)
		if err != nil || h.Failures != i || h.RetryAt < time.Now().Unix()+int64(1<<(i-1))*60-2 {
			t.Fatalf("health=%+v err=%v", h, err)
		}
	}
	fresh, _ := a.db.GetAccount(context.Background(), acc.ID)
	if deref(fresh.Status) != "alive" || fresh.LoginBuffer != "secret-buffer" {
		t.Fatalf("credentials changed: %+v", fresh)
	}
	if err := a.db.RecordRefresh(context.Background(), acc.ID, "", false); err != nil {
		t.Fatal(err)
	}
	h, _ := a.db.GetRefreshHealth(context.Background(), acc.ID)
	if h.Failures != 0 || h.RetryAt != 0 || h.LastSuccessAt == 0 || h.LastError != "" {
		t.Fatalf("health=%+v", h)
	}
}

func TestOnlyExplicitRefreshRejectionMarksExpired(t *testing.T) {
	a, acc := healthTestApp(t)
	status, _ := a.recordRefreshFailure(context.Background(), acc, errors.New("refresh failed: code=500 msg=temporarily unavailable"))
	if status != "retry" {
		t.Fatal(status)
	}
	status, _ = a.recordRefreshFailure(context.Background(), acc, protocol.RefreshRejectedError{Code: 40030})
	fresh, _ := a.db.GetAccount(context.Background(), acc.ID)
	if status != "expired" || deref(fresh.Status) != "expired" {
		t.Fatalf("status=%s account=%+v", status, fresh)
	}
}

func TestRefreshHealthPreservesSafeStageAndNumericCodes(t *testing.T) {
	a, acc := healthTestApp(t)
	_, err := a.recordRefreshFailure(context.Background(), acc, protocol.ProtocolError{Stage: "login_buffer", Kind: "business", Code: 500})
	if err == nil || !strings.Contains(err.Error(), "login_buffer") || !strings.Contains(err.Error(), "500") {
		t.Fatalf("diagnostic=%v", err)
	}
	h, _ := a.db.GetRefreshHealth(context.Background(), acc.ID)
	if h.LastError != err.Error() || h.Failures != 1 {
		t.Fatalf("health=%+v", h)
	}
}

func TestCancelledLoginBufferRequestStillPersistsRotatedCredentials(t *testing.T) {
	a, acc := healthTestApp(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	creds := protocol.CredentialsFromMap(acc.Credentials)
	creds.RefreshToken = "rotated-refresh"
	creds.AccessToken = "rotated-access"
	if err := a.preserveRotatedCredentials(ctx, acc, protocol.LoginBufferResult{Refreshed: true, Credentials: creds}); err != nil {
		t.Fatal(err)
	}
	fresh, err := a.db.GetAccount(context.Background(), acc.ID)
	if err != nil || protocol.CredentialsFromMap(fresh.Credentials).RefreshToken != "rotated-refresh" || fresh.LoginBuffer != acc.LoginBuffer {
		t.Fatal("rotated credentials were not preserved")
	}
}

func TestRefreshRechecksPersistedStatusBeforeCallingUpstream(t *testing.T) {
	a, stale := healthTestApp(t)
	if err := a.db.SetAccountStatus(context.Background(), stale.ID, "expired"); err != nil {
		t.Fatal(err)
	}
	status, err := a.refreshLivenessResult(context.Background(), stale)
	var expired accountExpiredError
	if status != "expired" || !errors.As(err, &expired) {
		t.Fatalf("status=%s err=%v", status, err)
	}
}

func TestRefreshLockWaitCanBeCancelled(t *testing.T) {
	a, acc := healthTestApp(t)
	gate := make(chan struct{}, 1)
	gate <- struct{}{}
	a.refreshLocks.Store(acc.ID, gate)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	status, err := a.refreshLivenessResult(ctx, acc)
	if status != "retry" || !errors.Is(err, context.Canceled) {
		t.Fatalf("status=%s err=%v", status, err)
	}
}

func TestNetworkProtocolFailurePreservesSessionAndDoesNotReplay(t *testing.T) {
	a, acc := healthTestApp(t)
	ctx := context.Background()
	if err := a.db.PutSession(ctx, acc.ID, nil, map[string]any{"test": true}, time.Now().Add(time.Hour).Unix(), ""); err != nil {
		t.Fatal(err)
	}
	for _, cause := range []error{context.DeadlineExceeded, io.EOF, errors.New("socks5 proxy handshake timeout")} {
		calls := 0
		_, err := a.invokeWXApp(ctx, acc, "test-app", nil, func(context.Context, *store.WechatAccount, string, map[string]any) (map[string]any, error) {
			calls++
			return nil, cause
		})
		if !errors.Is(err, cause) || calls != 1 {
			t.Fatalf("err=%v calls=%d", err, calls)
		}
		if _, err := a.db.GetSession(ctx, acc.ID, ""); err != nil {
			t.Fatalf("session removed: %v", err)
		}
	}
}

func TestHealthIsAuthenticatedAndDoesNotExposeSecrets(t *testing.T) {
	a, acc := healthTestApp(t)
	_ = a.db.RecordRefresh(context.Background(), acc.ID, "", false)
	previousToken := ApiToken
	ApiToken = "health-test-token"
	t.Cleanup(func() { ApiToken = previousToken })
	for _, authorized := range []bool{false, true} {
		req := httptest.NewRequest(http.MethodGet, "/accounts/health?ref=wx-test", nil)
		if authorized {
			req.Header.Set("Authorization", "Bearer "+ApiToken)
		}
		res := httptest.NewRecorder()
		a.Handler().ServeHTTP(res, req)
		if !authorized {
			if res.Code != http.StatusUnauthorized {
				t.Fatal(res.Code)
			}
			continue
		}
		if res.Code != http.StatusOK {
			t.Fatal(res.Code, res.Body.String())
		}
		for _, secret := range []string{"secret-buffer", "secret-access", "secret-refresh"} {
			if strings.Contains(res.Body.String(), secret) {
				t.Fatal("secret exposed")
			}
		}
		var body struct {
			Data struct {
				ExpiresAt int64               `json:"expires_at"`
				Refresh   store.RefreshHealth `json:"refresh"`
			} `json:"data"`
		}
		if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil || body.Data.ExpiresAt == 0 || body.Data.Refresh.LastSuccessAt == 0 {
			t.Fatalf("body=%s err=%v", res.Body.String(), err)
		}
	}
}
