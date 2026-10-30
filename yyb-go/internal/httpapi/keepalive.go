package httpapi

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"yyb_go/internal/protocol"
)

func envDuration(name string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	if raw == "0" {
		return 0
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value < 0 {
		panic(fmt.Sprintf("invalid %s: expected a non-negative duration", name))
	}
	return value
}

func (a *App) startKeepalive() {
	interval := envDuration("YYB_KEEPALIVE_INTERVAL", time.Minute)
	if interval <= 0 {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.keepaliveCancel = cancel
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				a.runKeepalive(ctx)
			}
		}
	}()
}

func (a *App) runKeepalive(ctx context.Context) {
	a.userDataMu.RLock()
	defer a.userDataMu.RUnlock()
	accounts, err := a.db.ListAccounts(ctx)
	if err != nil {
		log.Printf("YYB keepalive list accounts: %v", err)
		return
	}
	directAhead := envDuration("YYB_KEEPALIVE_AHEAD", 45*time.Minute)
	proxyAhead := envDuration("YYB_KEEPALIVE_PROXY_AHEAD", 5*time.Minute)
	for _, acc := range accounts {
		if ctx.Err() != nil || acc.Credentials == nil {
			continue
		}
		if acc.Status != nil && *acc.Status == "expired" {
			continue
		}
		health, healthErr := a.db.GetRefreshHealth(ctx, acc.ID)
		if healthErr != nil || health.RetryAt > time.Now().Unix() {
			continue
		}
		creds := protocol.CredentialsFromMap(acc.Credentials)
		setting, settingErr := a.db.GetAccountProxySetting(ctx, acc.ID, acc.OwnerRole, acc.OwnerUserID)
		if settingErr != nil {
			continue
		}
		ahead := directAhead
		if setting.Mode == "static" {
			ahead = proxyAhead
		}
		if !creds.Expired(ahead) && health.LastError == "" {
			continue
		}
		attemptCtx, cancel := context.WithTimeout(ctx, a.cfg.RequestTimeout+35*time.Second)
		status := a.refreshLiveness(attemptCtx, acc)
		cancel()
		if status != "alive" {
			log.Printf("YYB keepalive account %d status=%s", acc.ID, status)
		}
	}
}
