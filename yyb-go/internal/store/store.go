package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"time"

	_ "modernc.org/sqlite"
)

const SchemaVersion = 3

const schema = `
CREATE TABLE retired_users (user_id INTEGER PRIMARY KEY CHECK(user_id > 1000));
CREATE TABLE IF NOT EXISTS wechat_accounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    openid          TEXT    NOT NULL,
    owner_user_id INTEGER NOT NULL CHECK(owner_user_id >= 1000 AND owner_user_id <= 9007199254740991),
    owner_role      TEXT    NOT NULL CHECK((owner_role='admin' AND owner_user_id=1000) OR (owner_role='user' AND owner_user_id>1000)),
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
    updated_at      INTEGER NOT NULL,
    UNIQUE(owner_user_id, openid)
);
CREATE INDEX IF NOT EXISTS idx_wxacc_uin ON wechat_accounts(uin);
CREATE TRIGGER prevent_retired_accounts BEFORE INSERT ON wechat_accounts
WHEN EXISTS (SELECT 1 FROM retired_users WHERE user_id=NEW.owner_user_id)
BEGIN SELECT RAISE(ABORT, 'user is permanently retired'); END;


CREATE TABLE IF NOT EXISTS account_refresh_health (
    account_id INTEGER PRIMARY KEY REFERENCES wechat_accounts(id) ON DELETE CASCADE,
    last_attempt_at INTEGER NOT NULL DEFAULT 0,
    last_success_at INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    failures INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS proxy_profiles (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    protocol   TEXT    NOT NULL,
    host       TEXT    NOT NULL,
    port       INTEGER NOT NULL,
    username   TEXT    NOT NULL DEFAULT '',
    password   TEXT    NOT NULL DEFAULT '',
    owner_user_id INTEGER NOT NULL CHECK(owner_user_id >= 1000 AND owner_user_id <= 9007199254740991),
    shared_with_users INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(owner_user_id, name)
);

CREATE TRIGGER prevent_retired_proxies BEFORE INSERT ON proxy_profiles
WHEN EXISTS (SELECT 1 FROM retired_users WHERE user_id=NEW.owner_user_id)
BEGIN SELECT RAISE(ABORT, 'user is permanently retired'); END;

CREATE TABLE IF NOT EXISTS account_proxy_settings (
    wechat_account_id INTEGER PRIMARY KEY REFERENCES wechat_accounts(id) ON DELETE CASCADE,
    mode              TEXT    NOT NULL DEFAULT 'direct',
    proxy_profile_id  INTEGER REFERENCES proxy_profiles(id) ON DELETE SET NULL,
    updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
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
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS features (
    code        INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL UNIQUE,
    description TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1
);
`

var defaultFeatures = []Feature{
	{Code: 1001, Name: "getCode", Description: stringPtr("wx.login code"), Enabled: true},
	{Code: 1002, Name: "getPhoneNumber", Description: stringPtr("取手机号"), Enabled: true},
	{Code: 1003, Name: "operateWxData", Description: stringPtr("通用云函数代理"), Enabled: true},
}

type DB struct {
	sql *sql.DB
}

type WechatAccount struct {
	OwnerUserID   int64          `json:"-"`
	OwnerRole     string         `json:"-"`
	ID            int64          `json:"id"`
	OpenID        string         `json:"openid"`
	UIN           *int64         `json:"uin,omitempty"`
	Alias         *string        `json:"alias,omitempty"`
	Nickname      *string        `json:"nickname,omitempty"`
	Avatar        *string        `json:"avatar,omitempty"`
	UserInfo      map[string]any `json:"user_info,omitempty"`
	LoginBuffer   string         `json:"login_buffer,omitempty"`
	Credentials   map[string]any `json:"credentials,omitempty"`
	Status        *string        `json:"status,omitempty"`
	LastCheckedAt *int64         `json:"last_checked_at,omitempty"`
	CreatedAt     int64          `json:"created_at"`
	UpdatedAt     int64          `json:"updated_at"`
}

type AccountPublic struct {
	ID            int64   `json:"id"`
	OpenID        string  `json:"openid"`
	UIN           *int64  `json:"uin"`
	Alias         *string `json:"alias"`
	Nickname      *string `json:"nickname"`
	Avatar        *string `json:"avatar"`
	Status        *string `json:"status"`
	LastCheckedAt *int64  `json:"last_checked_at"`
	CreatedAt     int64   `json:"created_at"`
	UpdatedAt     int64   `json:"updated_at"`
}

type ProxyProfile struct {
	ID              int64  `json:"id"`
	Name            string `json:"name"`
	Protocol        string `json:"protocol"`
	Host            string `json:"host"`
	Port            int    `json:"port"`
	Username        string `json:"username"`
	Password        string `json:"-"`
	OwnerUserID     int64  `json:"-"`
	SharedWithUsers bool   `json:"shared_with_users"`
	CreatedAt       int64  `json:"created_at"`
	UpdatedAt       int64  `json:"updated_at"`
}

type ProxyProfilePublic struct {
	ID                 int64  `json:"id"`
	Name               string `json:"name"`
	Protocol           string `json:"protocol,omitempty"`
	Host               string `json:"host,omitempty"`
	Port               int    `json:"port,omitempty"`
	Username           string `json:"username,omitempty"`
	PasswordConfigured bool   `json:"password_configured,omitempty"`
	SharedWithUsers    bool   `json:"shared_with_users,omitempty"`
	OwnerUserID        int64  `json:"owner_user_id,omitempty"`
	Redacted           bool   `json:"redacted,omitempty"`
	CreatedAt          int64  `json:"created_at,omitempty"`
	UpdatedAt          int64  `json:"updated_at,omitempty"`
}

type AccountProxySetting struct {
	AccountID      int64               `json:"account_id"`
	Mode           string              `json:"mode"`
	ProxyProfileID *int64              `json:"proxy_profile_id"`
	Profile        *ProxyProfilePublic `json:"profile,omitempty"`
	UpdatedAt      int64               `json:"updated_at"`
}

type SessionRow struct {
	ID              int64
	WechatAccountID int64
	UIN             *int64
	TCPProxy        string
	SessionBlob     map[string]any
	ExpiresAt       int64
	CreatedAt       int64
	UpdatedAt       int64
}

type Feature struct {
	Code        int     `json:"code"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
	Enabled     bool    `json:"enabled"`
}

func Open(path string) (*DB, error) {
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err = db.ExecContext(ctx, "PRAGMA busy_timeout=5000"); err != nil {
		db.Close()
		return nil, err
	}
	var version, tables int
	if err = db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		db.Close()
		return nil, err
	}
	if err = db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").Scan(&tables); err != nil {
		db.Close()
		return nil, err
	}
	if tables > 0 && version != SchemaVersion {
		db.Close()
		return nil, fmt.Errorf("unsupported database schema %d; initialize a new test database", version)
	}
	pragmas := []string{"PRAGMA synchronous=NORMAL", "PRAGMA foreign_keys=ON", "PRAGMA secure_delete=ON"}
	if path != ":memory:" {
		pragmas = append(pragmas, "PRAGMA journal_mode=WAL")
	}
	for _, statement := range pragmas {
		if _, err = db.ExecContext(ctx, statement); err != nil {
			db.Close()
			return nil, err
		}
	}
	if tables == 0 {
		tx, beginErr := db.BeginTx(ctx, nil)
		if beginErr != nil {
			db.Close()
			return nil, beginErr
		}
		if _, err = tx.ExecContext(ctx, schema); err == nil {
			_, err = tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version=%d", SchemaVersion))
		}
		if err != nil {
			tx.Rollback()
			db.Close()
			return nil, err
		}
		if err = tx.Commit(); err != nil {
			db.Close()
			return nil, err
		}
	}
	out := &DB{sql: db}
	if err = out.EnsureDefaultFeatures(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return out, nil
}

func (db *DB) Close() error {
	if db == nil || db.sql == nil {
		return nil
	}
	return db.sql.Close()
}

func (db *DB) EnsureDefaultFeatures(ctx context.Context) error {
	for _, f := range defaultFeatures {
		desc := nullableString(f.Description)
		if _, err := db.sql.ExecContext(ctx,
			"INSERT OR IGNORE INTO features(code, name, description, enabled) VALUES(?,?,?,1)",
			f.Code, f.Name, desc,
		); err != nil {
			return err
		}
	}
	return nil
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func (db *DB) UpsertAccount(ctx context.Context, openid, loginBuffer string, ownerUserID int64, ownerRole string, alias, nickname, avatar *string, userInfo map[string]any, credentials map[string]any, status *string) (*WechatAccount, error) {
	if !validProxyIdentity(ownerRole, ownerUserID) || ownerUserID < 1000 {
		return nil, fmt.Errorf("account owner is required")
	}
	if err := db.CheckActiveUser(ctx, ownerUserID); err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	userJSON, err := marshalNullable(userInfo)
	if err != nil {
		return nil, err
	}
	credJSON, err := marshalNullable(credentials)
	if err != nil {
		return nil, err
	}
	_, err = db.sql.ExecContext(ctx,
		`INSERT INTO wechat_accounts
		(openid, login_buffer, owner_user_id, owner_role, alias, nickname, avatar, user_info, credentials, status, created_at, updated_at)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(owner_user_id, openid) DO UPDATE SET
		login_buffer=excluded.login_buffer, alias=excluded.alias, nickname=excluded.nickname,
		avatar=excluded.avatar, user_info=excluded.user_info, credentials=excluded.credentials,
		status=excluded.status, updated_at=excluded.updated_at WHERE wechat_accounts.owner_user_id=excluded.owner_user_id`,
		openid, loginBuffer, ownerUserID, ownerRole, nullableString(alias), nullableString(nickname), nullableString(avatar),
		userJSON, credJSON, nullableString(status), now, now,
	)
	if err != nil {
		return nil, err
	}
	account, err := db.GetAccountByOpenID(ctx, openid, ownerUserID)
	if err == nil && account.OwnerUserID != ownerUserID {
		return nil, fmt.Errorf("account belongs to another user")
	}
	return account, err
}

func (db *DB) GetAccount(ctx context.Context, id int64) (*WechatAccount, error) {
	return db.scanAccount(db.sql.QueryRowContext(ctx, selectAccountSQL+" WHERE id=?", id))
}

func (db *DB) GetAccountByOpenID(ctx context.Context, openid string, userID int64) (*WechatAccount, error) {
	return db.scanAccount(db.sql.QueryRowContext(ctx, selectAccountSQL+" WHERE openid=? AND owner_user_id=?", openid, userID))
}

// ResolveAccount uses a farm database ID or an explicitly scoped OpenID. UIN aliases are not accepted.
func (db *DB) ResolveAccount(ctx context.Context, ref, role string, userID int64) (*WechatAccount, error) {
	if !validProxyIdentity(role, userID) || ref == "" {
		return nil, sql.ErrNoRows
	}
	if isDigits(ref) {
		n, err := strconv.ParseInt(ref, 10, 64)
		if err != nil || strconv.FormatInt(n, 10) != ref {
			return nil, sql.ErrNoRows
		}
		return db.GetAccount(ctx, n)
	}
	if role != "admin" {
		return db.GetAccountByOpenID(ctx, ref, userID)
	}
	rows, err := db.sql.QueryContext(ctx, selectAccountSQL+" WHERE openid=?", ref)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var account *WechatAccount
	for rows.Next() {
		if account != nil {
			return nil, fmt.Errorf("multiple user accounts match; use the account ID")
		}
		account, err = scanAccountRows(rows)
		if err != nil {
			return nil, err
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if account == nil {
		return nil, sql.ErrNoRows
	}
	return account, nil
}

func (db *DB) ListAccounts(ctx context.Context) ([]*WechatAccount, error) {
	rows, err := db.sql.QueryContext(ctx, selectAccountSQL+" ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*WechatAccount
	for rows.Next() {
		acc, err := scanAccountRows(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, acc)
	}
	return out, rows.Err()
}

func (db *DB) SetAccountUIN(ctx context.Context, id, uin int64) error {
	_, err := db.sql.ExecContext(ctx, "UPDATE wechat_accounts SET uin=?, updated_at=? WHERE id=?", uin, time.Now().Unix(), id)
	return err
}

func (db *DB) SetAccountProfile(ctx context.Context, id int64, nickname, avatar *string, userInfo map[string]any) error {
	userJSON, err := marshalNullable(userInfo)
	if err != nil {
		return err
	}
	_, err = db.sql.ExecContext(ctx,
		"UPDATE wechat_accounts SET nickname=?, avatar=?, user_info=?, updated_at=? WHERE id=?",
		nullableString(nickname), nullableString(avatar), userJSON, time.Now().Unix(), id,
	)
	return err
}

func (db *DB) SetAccountCredential(ctx context.Context, id int64, loginBuffer string, credentials map[string]any) error {
	credJSON, err := marshalNullable(credentials)
	if err != nil {
		return err
	}
	_, err = db.sql.ExecContext(ctx,
		"UPDATE wechat_accounts SET login_buffer=?, credentials=?, updated_at=? WHERE id=?",
		loginBuffer, credJSON, time.Now().Unix(), id,
	)
	return err
}

func (db *DB) SetAccountStatus(ctx context.Context, id int64, status string) error {
	now := time.Now().Unix()
	_, err := db.sql.ExecContext(ctx,
		"UPDATE wechat_accounts SET status=?, last_checked_at=?, updated_at=? WHERE id=?",
		status, now, now, id,
	)
	return err
}

func (db *DB) DeleteAccount(ctx context.Context, id int64) error {
	_, err := db.sql.ExecContext(ctx, "DELETE FROM wechat_accounts WHERE id=?", id)
	return err
}

func (db *DB) ListProxyProfiles(ctx context.Context, role string, userID int64) ([]ProxyProfilePublic, error) {
	if !validProxyIdentity(role, userID) {
		return nil, fmt.Errorf("valid user identity required")
	}
	query := `SELECT id, name, protocol, host, port, username, password, owner_user_id, shared_with_users, created_at, updated_at FROM proxy_profiles`
	args := []any{}
	if role != "admin" {
		query += ` WHERE owner_user_id=? OR (owner_user_id=1000 AND shared_with_users=1)`
		args = append(args, userID)
	}
	query += ` ORDER BY name, id`
	rows, err := db.sql.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]ProxyProfilePublic, 0)
	for rows.Next() {
		profile, err := scanProxyProfile(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, profile.PublicFor(role, userID))
	}
	return out, rows.Err()
}

func (db *DB) GetProxyProfile(ctx context.Context, id int64) (*ProxyProfile, error) {
	return scanProxyProfile(db.sql.QueryRowContext(ctx, `SELECT id, name, protocol, host, port, username, password, owner_user_id, shared_with_users, created_at, updated_at FROM proxy_profiles WHERE id=?`, id))
}

func (db *DB) UpsertProxyProfile(ctx context.Context, id int64, name, protocolName, host string, port int, username, password string, keepPassword bool, owner int64, shared bool) (*ProxyProfile, error) {
	if err := db.CheckActiveUser(ctx, owner); err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	if id > 0 {
		if keepPassword {
			_, err := db.sql.ExecContext(ctx, `UPDATE proxy_profiles SET name=?, protocol=?, host=?, port=?, username=?, owner_user_id=?, shared_with_users=?, updated_at=? WHERE id=?`, name, protocolName, host, port, username, owner, boolInt(shared && owner == 1000), now, id)
			if err != nil {
				return nil, err
			}
		} else {
			_, err := db.sql.ExecContext(ctx, `UPDATE proxy_profiles SET name=?, protocol=?, host=?, port=?, username=?, password=?, owner_user_id=?, shared_with_users=?, updated_at=? WHERE id=?`, name, protocolName, host, port, username, password, owner, boolInt(shared && owner == 1000), now, id)
			if err != nil {
				return nil, err
			}
		}
		return db.GetProxyProfile(ctx, id)
	}
	result, err := db.sql.ExecContext(ctx, `INSERT INTO proxy_profiles(name, protocol, host, port, username, password, owner_user_id, shared_with_users, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, name, protocolName, host, port, username, password, owner, boolInt(shared && owner == 1000), now, now)
	if err != nil {
		return nil, err
	}
	newID, err := result.LastInsertId()
	if err != nil {
		return nil, err
	}
	return db.GetProxyProfile(ctx, newID)
}

func (db *DB) DeleteProxyProfile(ctx context.Context, id int64) error {
	var count int
	if err := db.sql.QueryRowContext(ctx, `SELECT count(*) FROM account_proxy_settings WHERE proxy_profile_id=? AND mode='static'`, id).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return fmt.Errorf("proxy profile is used by %d account(s)", count)
	}
	_, err := db.sql.ExecContext(ctx, `DELETE FROM proxy_profiles WHERE id=?`, id)
	return err
}

func (db *DB) GetAccountProxySetting(ctx context.Context, accountID int64, role string, userID int64) (AccountProxySetting, error) {
	if !validProxyIdentity(role, userID) {
		return AccountProxySetting{}, fmt.Errorf("valid user identity required")
	}
	setting := AccountProxySetting{AccountID: accountID, Mode: "direct"}
	var profileID sql.NullInt64
	err := db.sql.QueryRowContext(ctx, `SELECT mode, proxy_profile_id, updated_at FROM account_proxy_settings WHERE wechat_account_id=?`, accountID).Scan(&setting.Mode, &profileID, &setting.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return setting, nil
	}
	if err != nil {
		return setting, err
	}
	if profileID.Valid {
		setting.ProxyProfileID = &profileID.Int64
		profile, getErr := db.GetProxyProfile(ctx, profileID.Int64)
		if getErr != nil {
			return AccountProxySetting{}, getErr
		}
		if !profile.AvailableTo(role, userID) {
			return AccountProxySetting{}, fmt.Errorf("proxy profile is not available to this user")
		}
		public := profile.PublicFor(role, userID)
		setting.Profile = &public
	}
	return setting, nil
}

func (db *DB) SetAccountProxySetting(ctx context.Context, accountID int64, mode string, profileID *int64, role string, userID int64) (AccountProxySetting, error) {
	if !validProxyIdentity(role, userID) {
		return AccountProxySetting{}, fmt.Errorf("valid user identity required")
	}
	if (mode != "direct" && mode != "static") || (mode == "static" && (profileID == nil || *profileID <= 0)) {
		return AccountProxySetting{}, fmt.Errorf("valid proxy setting required")
	}
	if mode == "direct" {
		profileID = nil
	}
	if mode == "static" && profileID != nil {
		profile, err := db.GetProxyProfile(ctx, *profileID)
		if err != nil {
			return AccountProxySetting{}, err
		}
		if !profile.AvailableTo(role, userID) {
			return AccountProxySetting{}, fmt.Errorf("proxy profile is not available to this user")
		}
	}
	now := time.Now().Unix()
	_, err := db.sql.ExecContext(ctx, `INSERT INTO account_proxy_settings(wechat_account_id, mode, proxy_profile_id, updated_at) VALUES(?,?,?,?) ON CONFLICT(wechat_account_id) DO UPDATE SET mode=excluded.mode, proxy_profile_id=excluded.proxy_profile_id, updated_at=excluded.updated_at`, accountID, mode, nullableInt(profileID), now)
	if err != nil {
		return AccountProxySetting{}, err
	}
	return db.GetAccountProxySetting(ctx, accountID, role, userID)
}

func (db *DB) ResolveAccountTCPProxy(ctx context.Context, accountID int64) (string, error) {
	account, err := db.GetAccount(ctx, accountID)
	if err != nil {
		return "", err
	}
	if err := db.CheckActiveUser(ctx, account.OwnerUserID); err != nil {
		return "", err
	}
	setting, err := db.GetAccountProxySetting(ctx, accountID, account.OwnerRole, account.OwnerUserID)
	if err != nil {
		return "", err
	}
	if setting.Mode == "direct" {
		return "", nil
	}
	if setting.Mode != "static" || setting.ProxyProfileID == nil {
		return "", fmt.Errorf("invalid static proxy binding")
	}
	profile, err := db.GetProxyProfile(ctx, *setting.ProxyProfileID)
	if err != nil {
		return "", err
	}
	if !profile.AvailableTo(account.OwnerRole, account.OwnerUserID) {
		return "", fmt.Errorf("proxy profile is unavailable to account owner")
	}
	return profile.ProxyURL(), nil
}

func (db *DB) GetSession(ctx context.Context, accountID int64, tcpProxy string) (*SessionRow, error) {
	row := db.sql.QueryRowContext(ctx,
		"SELECT id, wechat_account_id, uin, tcp_proxy, session_blob, expires_at, created_at, updated_at FROM sessions WHERE wechat_account_id=? AND tcp_proxy=? AND expires_at>?",
		accountID, tcpProxy, time.Now().Unix(),
	)
	return scanSession(row)
}

func (db *DB) PutSession(ctx context.Context, accountID int64, uin *int64, sessionBlob map[string]any, expiresAt int64, tcpProxy string) error {
	now := time.Now().Unix()
	blob, err := json.Marshal(sessionBlob)
	if err != nil {
		return err
	}
	_, err = db.sql.ExecContext(ctx,
		`INSERT INTO sessions
		(wechat_account_id, uin, tcp_proxy, session_blob, expires_at, created_at, updated_at)
		VALUES(?,?,?,?,?,?,?)
		ON CONFLICT(wechat_account_id, tcp_proxy) DO UPDATE SET
		uin=excluded.uin, session_blob=excluded.session_blob,
		expires_at=excluded.expires_at, updated_at=excluded.updated_at`,
		accountID, nullableInt(uin), tcpProxy, string(blob), expiresAt, now, now,
	)
	return err
}

func (db *DB) InvalidateSession(ctx context.Context, accountID int64, tcpProxy string) error {
	_, err := db.sql.ExecContext(ctx, "DELETE FROM sessions WHERE wechat_account_id=? AND tcp_proxy=?", accountID, tcpProxy)
	return err
}

func (db *DB) InvalidateAllSessions(ctx context.Context, accountID int64) error {
	_, err := db.sql.ExecContext(ctx, "DELETE FROM sessions WHERE wechat_account_id=?", accountID)
	return err
}

func (db *DB) PurgeExpiredSessions(ctx context.Context) (int64, error) {
	res, err := db.sql.ExecContext(ctx, "DELETE FROM sessions WHERE expires_at<=?", time.Now().Unix())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (db *DB) ListFeatures(ctx context.Context, onlyEnabled bool) ([]Feature, error) {
	sqlText := "SELECT code, name, description, enabled FROM features"
	if onlyEnabled {
		sqlText += " WHERE enabled=1"
	}
	sqlText += " ORDER BY code"
	rows, err := db.sql.QueryContext(ctx, sqlText)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Feature
	for rows.Next() {
		f, err := scanFeature(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (db *DB) ResolveFeature(ctx context.Context, ref any) (*Feature, error) {
	switch v := ref.(type) {
	case float64:
		return db.GetFeature(ctx, int(v))
	case int:
		return db.GetFeature(ctx, v)
	case string:
		if isDigits(v) {
			n, _ := strconv.Atoi(v)
			return db.GetFeature(ctx, n)
		}
		return db.GetFeatureByName(ctx, v)
	default:
		return nil, sql.ErrNoRows
	}
}

func (db *DB) GetFeature(ctx context.Context, code int) (*Feature, error) {
	row := db.sql.QueryRowContext(ctx, "SELECT code, name, description, enabled FROM features WHERE code=?", code)
	f, err := scanFeature(row)
	if err != nil {
		return nil, err
	}
	return &f, nil
}

func (db *DB) GetFeatureByName(ctx context.Context, name string) (*Feature, error) {
	row := db.sql.QueryRowContext(ctx, "SELECT code, name, description, enabled FROM features WHERE name=? COLLATE NOCASE", name)
	f, err := scanFeature(row)
	if err != nil {
		return nil, err
	}
	return &f, nil
}

func (a *WechatAccount) Public() AccountPublic {
	return AccountPublic{
		ID:            a.ID,
		OpenID:        a.OpenID,
		UIN:           a.UIN,
		Alias:         a.Alias,
		Nickname:      a.Nickname,
		Avatar:        a.Avatar,
		Status:        a.Status,
		LastCheckedAt: a.LastCheckedAt,
		CreatedAt:     a.CreatedAt,
		UpdatedAt:     a.UpdatedAt,
	}
}

const selectAccountSQL = `SELECT id, openid, owner_user_id, owner_role, uin, alias, nickname, avatar, user_info, login_buffer, credentials, status, last_checked_at, created_at, updated_at FROM wechat_accounts`

type accountScanner interface {
	Scan(dest ...any) error
}

type featureScanner interface {
	Scan(dest ...any) error
}

func (p ProxyProfile) PublicFor(role string, userID int64) ProxyProfilePublic {
	owner := p.OwnedBy(userID)

	if role != "admin" && !owner {
		return ProxyProfilePublic{ID: p.ID, Name: p.Name, Redacted: true}
	}
	public := ProxyProfilePublic{
		ID: p.ID, Name: p.Name, Protocol: p.Protocol, Host: p.Host, Port: p.Port,
		Username: p.Username, PasswordConfigured: p.Password != "", SharedWithUsers: p.SharedWithUsers, CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt,
	}
	if role == "admin" {
		public.OwnerUserID = p.OwnerUserID
	}
	return public
}

func (p ProxyProfile) OwnedBy(userID int64) bool {
	return userID >= 1000 && p.OwnerUserID == userID
}

func (p ProxyProfile) AvailableTo(role string, userID int64) bool {
	return validProxyIdentity(role, userID) && (role == "admin" || p.OwnedBy(userID) || (p.OwnerUserID == 1000 && p.SharedWithUsers))
}

func validProxyIdentity(role string, userID int64) bool {
	return userID <= 9007199254740991 && ((role == "admin" && userID == 1000) || (role == "user" && userID > 1000))
}

func (p ProxyProfile) ProxyURL() string {
	scheme := p.Protocol
	u := &url.URL{Scheme: scheme, Host: net.JoinHostPort(p.Host, strconv.Itoa(p.Port))}
	if p.Username != "" {
		if p.Password != "" {
			u.User = url.UserPassword(p.Username, p.Password)
		} else {
			u.User = url.User(p.Username)
		}
	}
	return u.String()
}

func scanProxyProfile(row accountScanner) (*ProxyProfile, error) {
	var profile ProxyProfile
	if err := row.Scan(&profile.ID, &profile.Name, &profile.Protocol, &profile.Host, &profile.Port, &profile.Username, &profile.Password, &profile.OwnerUserID, &profile.SharedWithUsers, &profile.CreatedAt, &profile.UpdatedAt); err != nil {
		return nil, err
	}
	return &profile, nil
}

func (db *DB) scanAccount(row accountScanner) (*WechatAccount, error) {
	return scanAccountRows(row)
}

func scanAccountRows(row accountScanner) (*WechatAccount, error) {
	var (
		a                       WechatAccount
		uin, lastChecked        sql.NullInt64
		alias, nickname, avatar sql.NullString
		userJSON, credJSON      sql.NullString
		status                  sql.NullString
	)
	err := row.Scan(
		&a.ID, &a.OpenID, &a.OwnerUserID, &a.OwnerRole, &uin, &alias, &nickname, &avatar, &userJSON,
		&a.LoginBuffer, &credJSON, &status, &lastChecked, &a.CreatedAt, &a.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	if uin.Valid {
		a.UIN = &uin.Int64
	}
	a.Alias = stringPtrFromNull(alias)
	a.Nickname = stringPtrFromNull(nickname)
	a.Avatar = stringPtrFromNull(avatar)
	a.Status = stringPtrFromNull(status)
	if lastChecked.Valid {
		a.LastCheckedAt = &lastChecked.Int64
	}
	if userJSON.Valid && userJSON.String != "" {
		if err := json.Unmarshal([]byte(userJSON.String), &a.UserInfo); err != nil {
			return nil, err
		}
	}
	if credJSON.Valid && credJSON.String != "" {
		if err := json.Unmarshal([]byte(credJSON.String), &a.Credentials); err != nil {
			return nil, err
		}
	}
	return &a, nil
}

func scanSession(row accountScanner) (*SessionRow, error) {
	var s SessionRow
	var uin sql.NullInt64
	var blob string
	if err := row.Scan(&s.ID, &s.WechatAccountID, &uin, &s.TCPProxy, &blob, &s.ExpiresAt, &s.CreatedAt, &s.UpdatedAt); err != nil {
		return nil, err
	}
	if uin.Valid {
		s.UIN = &uin.Int64
	}
	if err := json.Unmarshal([]byte(blob), &s.SessionBlob); err != nil {
		return nil, fmt.Errorf("decode session_blob: %w", err)
	}
	return &s, nil
}

func scanFeature(row featureScanner) (Feature, error) {
	var f Feature
	var desc sql.NullString
	var enabled int
	if err := row.Scan(&f.Code, &f.Name, &desc, &enabled); err != nil {
		return Feature{}, err
	}
	f.Description = stringPtrFromNull(desc)
	f.Enabled = enabled != 0
	return f, nil
}

func marshalNullable(v map[string]any) (sql.NullString, error) {
	if v == nil {
		return sql.NullString{}, nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return sql.NullString{}, err
	}
	return sql.NullString{String: string(b), Valid: true}, nil
}

func nullableString(s *string) sql.NullString {
	if s == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *s, Valid: true}
}

func nullableInt(v *int64) sql.NullInt64 {
	if v == nil {
		return sql.NullInt64{}
	}
	return sql.NullInt64{Int64: *v, Valid: true}
}

func stringPtrFromNull(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	return &v.String
}

func stringPtr(s string) *string { return &s }

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func (db *DB) CheckActiveUser(ctx context.Context, userID int64) error {
	if userID < 1000 || userID > 9007199254740991 {
		return fmt.Errorf("userID is required")
	}
	var retired int
	if err := db.sql.QueryRowContext(ctx, "SELECT count(*) FROM retired_users WHERE user_id=?", userID).Scan(&retired); err != nil {
		return err
	}
	if retired != 0 {
		return fmt.Errorf("user is permanently retired")
	}
	return nil
}

func (db *DB) PurgeUser(ctx context.Context, userID int64) ([]string, error) {
	if userID <= 1000 {
		return nil, fmt.Errorf("userID is required")
	}
	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, "SELECT openid FROM wechat_accounts WHERE owner_user_id=?", userID)
	if err != nil {
		return nil, err
	}
	openids := []string{}
	for rows.Next() {
		var openid string
		if err := rows.Scan(&openid); err != nil {
			rows.Close()
			return nil, err
		}
		openids = append(openids, openid)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	for _, statement := range []string{
		"INSERT OR IGNORE INTO retired_users(user_id) VALUES(?)",
		"DELETE FROM wechat_accounts WHERE owner_user_id=?",
		"DELETE FROM proxy_profiles WHERE owner_user_id=?",
	} {
		if _, err := tx.ExecContext(ctx, statement, userID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	// Truncate WAL pages that held the deleted credentials before reporting completion.
	var busy, logPages, checkpointed int
	if err := db.sql.QueryRowContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)").Scan(&busy, &logPages, &checkpointed); err != nil {
		return nil, err
	}
	if busy != 0 {
		return nil, fmt.Errorf("user deletion checkpoint is busy")
	}
	return openids, nil
}
