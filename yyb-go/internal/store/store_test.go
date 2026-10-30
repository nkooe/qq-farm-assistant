package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestOpenRejectsPreviousDatabaseSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.Exec("CREATE TABLE old_fixture(value TEXT); INSERT INTO old_fixture VALUES('original')"); err != nil {
		t.Fatal(err)
	}
	raw.Close()
	if db, err := Open(path); err == nil {
		db.Close()
		t.Fatal("previous schema was accepted")
	}
	raw, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	var value string
	if err := raw.QueryRow("SELECT value FROM old_fixture").Scan(&value); err != nil || value != "original" {
		t.Fatal("rejected database was modified")
	}
}

func TestProxyProfilesAndPerAccountAssignments(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "yyb.db"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()
	ctx := context.Background()
	account, err := db.UpsertAccount(ctx, "openid-proxy", "login-buffer", 1001, "user", nil, nil, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("UpsertAccount() error = %v", err)
	}
	profile, err := db.UpsertProxyProfile(ctx, 0, "fixed", "socks5", "127.0.0.1", 1080, "user", "secret", false, 1000, true)
	if err != nil {
		t.Fatalf("UpsertProxyProfile() error = %v", err)
	}
	setting, err := db.SetAccountProxySetting(ctx, account.ID, "static", &profile.ID, "admin", 1000)
	if err != nil || setting.Mode != "static" || setting.ProxyProfileID == nil {
		t.Fatalf("SetAccountProxySetting() = %#v, %v", setting, err)
	}
	proxyURL, err := db.ResolveAccountTCPProxy(ctx, account.ID)
	if err != nil || proxyURL != "socks5://user:secret@127.0.0.1:1080" {
		t.Fatalf("ResolveAccountTCPProxy() = %q, %v", proxyURL, err)
	}
	profiles, err := db.ListProxyProfiles(ctx, "admin", 1000)
	if err != nil || len(profiles) != 1 || !profiles[0].PasswordConfigured {
		t.Fatalf("ListProxyProfiles() = %#v, %v", profiles, err)
	}
	if err = db.DeleteProxyProfile(ctx, profile.ID); err == nil {
		t.Fatal("assigned proxy profile must not be deleted")
	}
	if _, err = db.SetAccountProxySetting(ctx, account.ID, "direct", nil, "admin", 1000); err != nil {
		t.Fatalf("set direct: %v", err)
	}
	if got, err := db.ResolveAccountTCPProxy(ctx, account.ID); err != nil || got != "" {
		t.Fatalf("direct proxy = %q, %v", got, err)
	}
}
