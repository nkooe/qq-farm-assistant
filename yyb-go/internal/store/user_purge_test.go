package store

import (
	"context"
	"path/filepath"
	"testing"
)

func TestCurrentSchemaReopensAndPurgesOnlyTheSelectedUser(t *testing.T) {
	path := filepath.Join(t.TempDir(), "current.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	a, err := db.UpsertAccount(ctx, "alice-openid", "fixture-buffer", 1001, "user", nil, nil, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.UpsertAccount(ctx, "bob-openid", "fixture-buffer", 1002, "user", nil, nil, nil, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	proxy, err := db.UpsertProxyProfile(ctx, 0, "own", "socks5", "192.0.2.1", 1080, "", "fixture", false, 1001, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.SetAccountProxySetting(ctx, a.ID, "static", &proxy.ID, "user", 1001); err != nil {
		t.Fatal(err)
	}
	db.Close()
	db, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.PurgeUser(ctx, 1001); err != nil {
		t.Fatal(err)
	}
	accounts, err := db.ListAccounts(ctx)
	if err != nil || len(accounts) != 1 || accounts[0].OwnerUserID != 1002 {
		t.Fatalf("purge accounts: %#v %v", accounts, err)
	}
	proxies, err := db.ListProxyProfiles(ctx, "admin", 1000)
	if err != nil || len(proxies) != 0 {
		t.Fatal("proxy credentials survived purge")
	}
	if _, err := db.UpsertAccount(ctx, "new-openid", "fixture-buffer", 1001, "user", nil, nil, nil, nil, nil, nil); err == nil {
		t.Fatal("retired identity accepted an account")
	}
	if _, err := db.UpsertProxyProfile(ctx, 0, "new", "socks5", "192.0.2.1", 1080, "", "", false, 1001, false); err == nil {
		t.Fatal("retired identity accepted a proxy")
	}
}
