package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"yyb_go/internal/protocol"
)

type proxyProfileInput struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Protocol string `json:"protocol"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
}

func validateProxyProfile(in proxyProfileInput) (proxyProfileInput, error) {
	in.Name = strings.TrimSpace(in.Name)
	in.Protocol = strings.ToLower(strings.TrimSpace(in.Protocol))
	in.Host = strings.TrimSpace(strings.Trim(in.Host, "[]"))
	in.Username = strings.TrimSpace(in.Username)
	if in.Protocol == "http" {
		in.Protocol = "http-connect"
	}
	if in.Name == "" {
		return in, fmt.Errorf("代理名称不能为空")
	}
	if in.Protocol != "http-connect" && in.Protocol != "socks5" {
		return in, fmt.Errorf("代理协议只支持 HTTP CONNECT 或 SOCKS5")
	}
	if in.Host == "" || strings.ContainsAny(in.Host, "/?#@") {
		return in, fmt.Errorf("代理主机无效")
	}
	if in.Port < 1 || in.Port > 65535 {
		return in, fmt.Errorf("代理端口必须为 1-65535")
	}
	return in, nil
}

func (a *App) handleProxyProfiles(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/proxy-profiles" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	switch r.Method {
	case http.MethodGet:
		profiles, err := a.db.ListProxyProfiles(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, profiles)
	case http.MethodPost:
		var input proxyProfileInput
		if err := decodeOptionalJSON(r, &input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
		input, err := validateProxyProfile(input)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		profile, err := a.db.UpsertProxyProfile(r.Context(), 0, input.Name, input.Protocol, input.Host, input.Port, input.Username, input.Password, false)
		if err != nil {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, profile.Public())
	case http.MethodPut:
		var input proxyProfileInput
		if err := decodeOptionalJSON(r, &input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
		if input.ID <= 0 {
			writeError(w, http.StatusBadRequest, "代理配置 ID 无效")
			return
		}
		input, err := validateProxyProfile(input)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		keepPassword := input.Password == "" || input.Password == "***" || input.Password == "__KEEP__"
		profile, err := a.db.UpsertProxyProfile(r.Context(), input.ID, input.Name, input.Protocol, input.Host, input.Port, input.Username, input.Password, keepPassword)
		if err != nil {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, profile.Public())
	case http.MethodDelete:
		id, err := strconv.ParseInt(strings.TrimSpace(r.URL.Query().Get("id")), 10, 64)
		if err != nil || id <= 0 {
			writeError(w, http.StatusBadRequest, "代理配置 ID 无效")
			return
		}
		if err = a.db.DeleteProxyProfile(r.Context(), id); err != nil {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *App) handleProxyProfileItem(w http.ResponseWriter, r *http.Request) {
	idText := strings.Trim(strings.TrimPrefix(r.URL.Path, "/proxy-profiles/"), "/")
	id, err := strconv.ParseInt(idText, 10, 64)
	if err != nil || id <= 0 {
		writeError(w, http.StatusNotFound, "proxy profile not found")
		return
	}
	switch r.Method {
	case http.MethodPut:
		var input proxyProfileInput
		if err = decodeOptionalJSON(r, &input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
		input, err = validateProxyProfile(input)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		keepPassword := input.Password == "" || input.Password == "***" || input.Password == "__KEEP__"
		profile, err := a.db.UpsertProxyProfile(r.Context(), id, input.Name, input.Protocol, input.Host, input.Port, input.Username, input.Password, keepPassword)
		if err != nil {
			status := http.StatusInternalServerError
			if errors.Is(err, sql.ErrNoRows) {
				status = http.StatusNotFound
			}
			writeError(w, status, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, profile.Public())
	case http.MethodDelete:
		if err = a.db.DeleteProxyProfile(r.Context(), id); err != nil {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"deleted": id})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *App) handleAccountProxy(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		acc, ok := a.resolveAccountFromQuery(w, r)
		if !ok {
			return
		}
		setting, err := a.db.GetAccountProxySetting(r.Context(), acc.ID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, setting)
	case http.MethodPut:
		var input struct {
			Ref            string `json:"ref"`
			Mode           string `json:"mode"`
			ProxyProfileID *int64 `json:"proxy_profile_id"`
		}
		if err := decodeOptionalJSON(r, &input); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
			return
		}
		acc, ok := a.resolveAccountRef(w, r, input.Ref)
		if !ok {
			return
		}
		mode, _, profileID, err := a.resolveRequestedProxy(r.Context(), input.Mode, input.ProxyProfileID)
		if err != nil || mode == "" {
			if err == nil {
				err = fmt.Errorf("代理模式不能为空")
			}
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		setting, err := a.db.SetAccountProxySetting(r.Context(), acc.ID, mode, profileID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		_ = a.db.InvalidateAllSessions(r.Context(), acc.ID)
		writeJSON(w, http.StatusOK, setting)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *App) handleProxyProfileTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var input struct {
		ProxyProfileID int64 `json:"proxy_profile_id"`
	}
	if err := decodeOptionalJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	profile, err := a.db.GetProxyProfile(r.Context(), input.ProxyProfileID)
	if err != nil {
		writeError(w, http.StatusNotFound, "代理配置不存在")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	started := time.Now()
	if err = protocol.TestTCPProxy(ctx, profile.ProxyURL(), "open.weixin.qq.com", 443, 10*time.Second); err != nil {
		writeError(w, http.StatusBadGateway, "代理隧道测试失败: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "latency_ms": time.Since(started).Milliseconds(), "target": net.JoinHostPort("open.weixin.qq.com", "443")})
}

func (a *App) resolveRequestedProxy(ctx context.Context, mode string, profileID *int64) (string, string, *int64, error) {
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "" {
		return "", "", nil, nil
	}
	if mode == "direct" {
		return "direct", "", nil, nil
	}
	if mode != "static" {
		return "", "", nil, fmt.Errorf("代理模式只支持 direct 或 static")
	}
	if profileID == nil || *profileID <= 0 {
		return "", "", nil, fmt.Errorf("静态代理必须选择代理配置")
	}
	profile, err := a.db.GetProxyProfile(ctx, *profileID)
	if err != nil {
		return "", "", nil, fmt.Errorf("代理配置不存在")
	}
	return "static", profile.ProxyURL(), profileID, nil
}
