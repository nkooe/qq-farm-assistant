package store

import (
	"context"
	"path/filepath"
	"testing"
)

func TestIdenticalOpenIDsHaveIndependentUserRecords(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "ids.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	a, err := db.UpsertAccount(ctx, "same-openid", "alice-secret", 1001, "user", nil, nil, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	b, err := db.UpsertAccount(ctx, "same-openid", "bob-secret", 1002, "user", nil, nil, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if a.ID == b.ID {
		t.Fatal("users share the same record")
	}
	for _, tc := range []struct {
		id     int64
		secret string
	}{{1001, "alice-secret"}, {1002, "bob-secret"}} {
		account, err := db.ResolveAccount(ctx, "same-openid", "user", tc.id)
		if err != nil || account.LoginBuffer != tc.secret {
			t.Fatal("credential scope mismatch", err)
		}
	}
	if _, err := db.ResolveAccount(ctx, "same-openid", "admin", 1000); err == nil {
		t.Fatal("ambiguous admin OpenID lookup accepted")
	}
	if _, err := db.PurgeUser(ctx, 1001); err != nil {
		t.Fatal(err)
	}
	remaining, err := db.GetAccount(ctx, b.ID)
	if err != nil || remaining.LoginBuffer != "bob-secret" {
		t.Fatal("other user's data removed", err)
	}
}

func TestOnlyID1000CanBeAdministrator(t *testing.T) {
	for _, tc := range []struct {
		role string
		id   int64
	}{{"admin", 1001}, {"user", 1000}, {"admin", 0}, {"user", 999}, {"user", 9007199254740992}} {
		if validProxyIdentity(tc.role, tc.id) {
			t.Fatal("invalid identity accepted", tc)
		}
	}
	if !validProxyIdentity("admin", 1000) || !validProxyIdentity("user", 1001) {
		t.Fatal("valid identities rejected")
	}
}
