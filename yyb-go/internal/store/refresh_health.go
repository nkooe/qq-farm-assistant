package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// RefreshHealth deliberately contains no credentials or proxy addresses.
type RefreshHealth struct {
	LastAttemptAt int64  `json:"last_attempt_at"`
	LastSuccessAt int64  `json:"last_success_at"`
	LastError     string `json:"last_error"`
	Failures      int    `json:"failures"`
	RetryAt       int64  `json:"retry_at"`
}

func (db *DB) Ping(ctx context.Context) error { return db.sql.PingContext(ctx) }

func (db *DB) GetRefreshHealth(ctx context.Context, id int64) (RefreshHealth, error) {
	var h RefreshHealth
	err := db.sql.QueryRowContext(ctx, `SELECT last_attempt_at, last_success_at, last_error, failures, retry_at
		FROM account_refresh_health WHERE account_id=?`, id).Scan(&h.LastAttemptAt, &h.LastSuccessAt, &h.LastError, &h.Failures, &h.RetryAt)
	if errors.Is(err, sql.ErrNoRows) {
		return h, nil
	}
	return h, err
}

func (db *DB) RecordRefresh(ctx context.Context, id int64, message string, retry bool) error {
	h, err := db.GetRefreshHealth(ctx, id)
	if err != nil {
		return err
	}
	now := time.Now().Unix()
	h.LastAttemptAt, h.LastError, h.RetryAt = now, message, 0
	if message == "" {
		h.LastSuccessAt, h.Failures = now, 0
	} else {
		h.Failures++
		if retry {
			// 1, 2, 4, 8, 16, then 30 minutes. Manual requests bypass this schedule.
			minutes := 1 << min(h.Failures-1, 5)
			if minutes > 30 {
				minutes = 30
			}
			h.RetryAt = now + int64(minutes)*60
		}
	}
	_, err = db.sql.ExecContext(ctx, `INSERT INTO account_refresh_health
		(account_id,last_attempt_at,last_success_at,last_error,failures,retry_at) VALUES(?,?,?,?,?,?)
		ON CONFLICT(account_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,
		last_success_at=excluded.last_success_at,last_error=excluded.last_error,failures=excluded.failures,retry_at=excluded.retry_at`,
		id, h.LastAttemptAt, h.LastSuccessAt, h.LastError, h.Failures, h.RetryAt)
	return err
}
