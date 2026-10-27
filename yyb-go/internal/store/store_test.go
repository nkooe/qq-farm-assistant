package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

func TestOpenMigratesWMPFSessionsTableToSessions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "yyb.db")
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	ctx := context.Background()
	if _, err = raw.ExecContext(ctx, `
CREATE TABLE wechat_accounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    openid          TEXT    NOT NULL UNIQUE,
    uin             INTEGER,
    alias           TEXT,
    nickname        TEXT,
    avatar          TEXT,
    user_info       TEXT,
    login_buffer    TEXT    NOT NULL,
    credentials     TEXT,
    status          TEXT,
    last_checked_at INTEGER,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE TABLE wmpf_sessions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    wechat_account_id INTEGER NOT NULL REFERENCES wechat_accounts(id) ON DELETE CASCADE,
    uin               INTEGER,
    tcp_proxy         TEXT    NOT NULL DEFAULT '',
    session_blob      TEXT    NOT NULL,
    expires_at        INTEGER NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    UNIQUE(wechat_account_id, tcp_proxy)
);
CREATE INDEX idx_sess_expires ON wmpf_sessions(expires_at);
INSERT INTO wechat_accounts(id, openid, login_buffer, created_at, updated_at)
VALUES(1, 'openid-1', 'login-buffer', 10, 10);
INSERT INTO wmpf_sessions(id, wechat_account_id, uin, tcp_proxy, session_blob, expires_at, created_at, updated_at)
VALUES(7, 1, 12345, '', '{"ready":true}', ?, 20, 20);
`, time.Now().Add(time.Hour).Unix()); err != nil {
		_ = raw.Close()
		t.Fatalf("seed old schema: %v", err)
	}
	if err = raw.Close(); err != nil {
		t.Fatalf("close seed db: %v", err)
	}

	db, err := Open(path)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()

	oldExists, err := sqliteTableExists(ctx, db.sql, "wmpf_sessions")
	if err != nil {
		t.Fatalf("check old table: %v", err)
	}
	if oldExists {
		t.Fatalf("old wmpf_sessions table still exists")
	}
	newExists, err := sqliteTableExists(ctx, db.sql, "sessions")
	if err != nil {
		t.Fatalf("check new table: %v", err)
	}
	if !newExists {
		t.Fatalf("new sessions table does not exist")
	}

	session, err := db.GetSession(ctx, 1, "")
	if err != nil {
		t.Fatalf("GetSession() error = %v", err)
	}
	if session.ID != 7 {
		t.Fatalf("session id = %d, want 7", session.ID)
	}
	if ready, ok := session.SessionBlob["ready"].(bool); !ok || !ready {
		t.Fatalf("session blob = %#v", session.SessionBlob)
	}
}

func TestProxyProfilesAndPerAccountAssignments(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "yyb.db"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()
	ctx := context.Background()
	account, err := db.UpsertAccount(ctx, "openid-proxy", "login-buffer", nil, nil, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("UpsertAccount() error = %v", err)
	}
	profile, err := db.UpsertProxyProfile(ctx, 0, "fixed", "socks5", "127.0.0.1", 1080, "user", "secret", false)
	if err != nil {
		t.Fatalf("UpsertProxyProfile() error = %v", err)
	}
	setting, err := db.SetAccountProxySetting(ctx, account.ID, "static", &profile.ID)
	if err != nil || setting.Mode != "static" || setting.ProxyProfileID == nil {
		t.Fatalf("SetAccountProxySetting() = %#v, %v", setting, err)
	}
	proxyURL, err := db.ResolveAccountTCPProxy(ctx, account.ID)
	if err != nil || proxyURL != "socks5://user:secret@127.0.0.1:1080" {
		t.Fatalf("ResolveAccountTCPProxy() = %q, %v", proxyURL, err)
	}
	profiles, err := db.ListProxyProfiles(ctx)
	if err != nil || len(profiles) != 1 || !profiles[0].PasswordConfigured {
		t.Fatalf("ListProxyProfiles() = %#v, %v", profiles, err)
	}
	if err = db.DeleteProxyProfile(ctx, profile.ID); err == nil {
		t.Fatal("assigned proxy profile must not be deleted")
	}
	if _, err = db.SetAccountProxySetting(ctx, account.ID, "direct", nil); err != nil {
		t.Fatalf("set direct: %v", err)
	}
	if got, err := db.ResolveAccountTCPProxy(ctx, account.ID); err != nil || got != "" {
		t.Fatalf("direct proxy = %q, %v", got, err)
	}
}
