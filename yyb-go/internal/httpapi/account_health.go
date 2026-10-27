package httpapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"yyb_go/internal/protocol"
	"yyb_go/internal/store"
)

func temporaryProtocolError(err error) bool {
	var network net.Error
	if errors.As(err, &network) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	text := strings.ToLower(err.Error())
	for _, marker := range []string{"timeout", "cancelled", "connection reset", "broken pipe", "dial proxy failed", "proxy handshake", "no such host", " eof"} {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
}

func (a *App) recordRefreshFailure(ctx context.Context, acc *store.WechatAccount, err error) (string, error) {
	// Persist diagnostics even when the network request exhausted its context.
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	var rejected protocol.RefreshRejectedError
	if errors.As(err, &rejected) {
		_ = a.db.SetAccountStatus(writeCtx, acc.ID, "expired")
		_ = a.db.RecordRefresh(writeCtx, acc.ID, "微信已明确拒绝刷新凭据，请使用原微信重新扫码", false)
		return "expired", rejected
	}
	message := "凭据刷新暂时失败，将自动重试"
	if temporaryProtocolError(err) {
		message = "网络或代理连接异常，将自动重试"
	}
	var diagnostic protocol.ProtocolError
	if errors.As(err, &diagnostic) {
		message += fmt.Sprintf("（阶段=%s，类型=%s，code=%d，HTTP=%d）", diagnostic.Stage, diagnostic.Kind, diagnostic.Code, diagnostic.HTTPStatus)
		log.Printf("YYB credential refresh account=%d stage=%s kind=%s code=%d http=%d", acc.ID, diagnostic.Stage, diagnostic.Kind, diagnostic.Code, diagnostic.HTTPStatus)
	}
	_ = a.db.RecordRefresh(writeCtx, acc.ID, message, true)
	// Never expose proxy passwords, extraction URLs or tokens from upstream errors.
	return "retry", errors.New(message)
}

func (a *App) preserveRotatedCredentials(ctx context.Context, acc *store.WechatAccount, result protocol.LoginBufferResult) error {
	if !result.Refreshed || result.Credentials.AccessToken == "" {
		return nil
	}
	// The refresh endpoint may already have invalidated the previous refresh token.
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer cancel()
	return a.db.SetAccountCredential(writeCtx, acc.ID, acc.LoginBuffer, result.Credentials.ToMap())
}

func (a *App) handleAccountsHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	acc, ok := a.resolveAccountFromQuery(w, r)
	if !ok {
		return
	}
	health, err := a.db.GetRefreshHealth(r.Context(), acc.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read account health")
		return
	}
	creds := protocol.CredentialsFromMap(acc.Credentials)
	status := deref(acc.Status)
	writeJSON(w, http.StatusOK, map[string]any{
		"status": status, "expires_at": creds.ExpiresAt,
		"needs_rescan": status == "expired", "refresh": health,
		"keepalive_enabled": envDuration("YYB_KEEPALIVE_INTERVAL", time.Minute) > 0,
	})
}
