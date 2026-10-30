package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"yyb_go/internal/protocol"
)

// Only the local core service may resolve credentials, never a browser route.
func (a *App) handleInternalProxyURL(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || !net.ParseIP(host).IsLoopback() || ApiToken == "" || r.Header.Get("Authorization") != "Bearer "+ApiToken {
		writeError(w, http.StatusForbidden, "local service authentication required")
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var input struct {
		ProfileID *int64 `json:"proxy_profile_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	role, userID := proxyCaller(r)
	_, value, _, err := a.resolveRequestedProxy(r.Context(), "static", input.ProfileID, role, userID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "proxy profile unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": value})
}

type proxyProfileInput struct {
	ID              int64  `json:"id"`
	Name            string `json:"name"`
	Protocol        string `json:"protocol"`
	Host            string `json:"host"`
	Port            int    `json:"port"`
	Username        string `json:"username"`
	Password        string `json:"password"`
	SharedWithUsers bool   `json:"shared_with_users"`
}

func proxyCaller(r *http.Request) (role string, userID int64) {
	role = r.Header.Get("X-Farm-Role")
	raw := r.Header.Get("X-Farm-User-ID")
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || strconv.FormatInt(id, 10) != raw || id < 1000 || id > 9007199254740991 || (id == 1000 && role != "admin") || (id > 1000 && role != "user") {
		return "", 0
	}
	return role, id
}

func proxyRequestError(role, proxyURL string, err error) string {
	if role != "admin" && proxyURL != "" {
		return "代理连接失败，请检查所选代理或联系管理员"
	}
	return err.Error()
}

func validateProxyProfile(in proxyProfileInput) (proxyProfileInput, error) {
	in.Name = strings.TrimSpace(in.Name)
	in.Protocol = strings.ToLower(strings.TrimSpace(in.Protocol))
	in.Host = strings.TrimSpace(strings.Trim(in.Host, "[]"))
	in.Username = strings.TrimSpace(in.Username)
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
	role, userID := proxyCaller(r)
	if (role != "admin" && role != "user") || userID == 0 {
		writeError(w, http.StatusForbidden, "缺少用户身份")
		return
	}
	if r.URL.Path != "/proxy-profiles" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	switch r.Method {
	case http.MethodGet:
		role, userID := proxyCaller(r)
		profiles, err := a.db.ListProxyProfiles(r.Context(), role, userID)
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
		role, userID := proxyCaller(r)
		owner := userID
		profile, err := a.db.UpsertProxyProfile(r.Context(), 0, input.Name, input.Protocol, input.Host, input.Port, input.Username, input.Password, false, owner, role == "admin" && input.SharedWithUsers)
		if err != nil {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, profile.PublicFor(role, userID))
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
		role, userID := proxyCaller(r)
		current, getErr := a.db.GetProxyProfile(r.Context(), input.ID)
		if getErr != nil {
			writeError(w, http.StatusNotFound, "代理配置不存在")
			return
		}
		if role != "admin" && !current.OwnedBy(userID) {
			writeError(w, http.StatusForbidden, "代理配置不属于当前用户")
			return
		}
		keepPassword := input.Password == "__KEEP__"
		profile, err := a.db.UpsertProxyProfile(r.Context(), input.ID, input.Name, input.Protocol, input.Host, input.Port, input.Username, input.Password, keepPassword, current.OwnerUserID, role == "admin" && input.SharedWithUsers)
		if err != nil {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, profile.PublicFor(role, userID))
	case http.MethodDelete:
		id, err := strconv.ParseInt(strings.TrimSpace(r.URL.Query().Get("id")), 10, 64)
		if err != nil || id <= 0 {
			writeError(w, http.StatusBadRequest, "代理配置 ID 无效")
			return
		}
		role, userID := proxyCaller(r)
		profile, getErr := a.db.GetProxyProfile(r.Context(), id)
		if getErr != nil {
			writeError(w, http.StatusNotFound, "代理配置不存在")
			return
		}
		if role != "admin" && !profile.OwnedBy(userID) {
			writeError(w, http.StatusForbidden, "代理配置不属于当前用户")
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

func (a *App) handleAccountProxy(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		acc, ok := a.resolveAccountFromQuery(w, r)
		if !ok {
			return
		}
		role, userID := proxyCaller(r)
		setting, err := a.db.GetAccountProxySetting(r.Context(), acc.ID, role, userID)
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
		role, userID := proxyCaller(r)
		mode, _, profileID, err := a.resolveRequestedProxy(r.Context(), input.Mode, input.ProxyProfileID, role, userID)
		if err != nil || mode == "" {
			if err == nil {
				err = fmt.Errorf("代理模式不能为空")
			}
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		setting, err := a.db.SetAccountProxySetting(r.Context(), acc.ID, mode, profileID, role, userID)
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
	role, userID := proxyCaller(r)
	if !profile.AvailableTo(role, userID) {
		writeError(w, http.StatusForbidden, "代理配置不属于当前用户")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	started := time.Now()
	if err = protocol.TestTCPProxy(ctx, profile.ProxyURL(), "open.weixin.qq.com", 443, 10*time.Second); err != nil {
		message := "代理隧道测试失败，请检查代理服务"
		if role == "admin" || profile.OwnedBy(userID) {
			message += ": " + err.Error()
		}
		writeError(w, http.StatusBadGateway, message)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "latency_ms": time.Since(started).Milliseconds(), "target": net.JoinHostPort("open.weixin.qq.com", "443")})
}

func (a *App) resolveRequestedProxy(ctx context.Context, mode string, profileID *int64, role string, userID int64) (string, string, *int64, error) {
	if role != "admin" && (role != "user" || userID == 0) {
		return "", "", nil, fmt.Errorf("缺少有效用户身份")
	}
	mode = strings.ToLower(strings.TrimSpace(mode))
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
	if !profile.AvailableTo(role, userID) {
		return "", "", nil, fmt.Errorf("代理配置不属于当前用户")
	}
	return "static", profile.ProxyURL(), profileID, nil
}
