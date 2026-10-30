package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	httpSwagger "github.com/swaggo/http-swagger/v2"

	"yyb_go/internal/protocol"
	"yyb_go/internal/qr"
	"yyb_go/internal/store"
)

type Config struct {
	ResourceRoot   string
	DBFilename     string
	TCPProxy       string
	SessionTTL     time.Duration
	RequestTimeout time.Duration
	AvatarTimeout  time.Duration
	ScanTimeout    time.Duration
	QRSessionTTL   time.Duration
}

type App struct {
	cfg       Config
	resources resources
	db        *store.DB
	pool      *protocol.Pool
	qr        *qr.Client

	mu              sync.Mutex
	userDataMu      sync.RWMutex
	qrSessions      map[string]*qr.Session
	refreshLocks    sync.Map
	keepaliveCancel context.CancelFunc
}

var swaggerDocsHandler = httpSwagger.Handler(
	httpSwagger.URL("/openapi.json"),
	httpSwagger.DocExpansion("list"),
	httpSwagger.DeepLinking(true),
	httpSwagger.DefaultModelsExpandDepth(httpSwagger.ShowModel),
)

func NewApp(cfg Config) (*App, error) {
	if cfg.ResourceRoot == "" {
		cfg.ResourceRoot = filepath.Join(".", "resource")
	}
	if cfg.DBFilename == "" {
		cfg.DBFilename = DefaultDBFilename
	}
	if cfg.RequestTimeout == 0 {
		cfg.RequestTimeout = 8 * time.Second
	}
	if cfg.AvatarTimeout == 0 {
		cfg.AvatarTimeout = 10 * time.Second
	}
	if cfg.SessionTTL == 0 {
		cfg.SessionTTL = 30 * time.Minute
	}
	if cfg.QRSessionTTL == 0 {
		cfg.QRSessionTTL = 5 * time.Minute
	}
	res, err := ensureResources(cfg.ResourceRoot)
	if err != nil {
		return nil, err
	}
	dbPath, err := prepareDBPath(res.DB, cfg.DBFilename)
	if err != nil {
		return nil, err
	}
	db, err := store.Open(dbPath)
	if err != nil {
		return nil, err
	}
	poolCfg := protocol.DefaultConfig()
	poolCfg.SessionTTL = cfg.SessionTTL
	poolCfg.ShortlinkTimeout = cfg.RequestTimeout
	poolCfg.TCPProxy = cfg.TCPProxy
	pool := protocol.NewPool(poolCfg, db)
	go sessionCleanupLoop()
	app := &App{
		cfg:        cfg,
		resources:  res,
		db:         db,
		pool:       pool,
		qr:         qr.NewClient(cfg.RequestTimeout),
		qrSessions: map[string]*qr.Session{},
	}
	if err := app.cleanupQR(nil); err != nil {
		db.Close()
		return nil, err
	}
	app.startKeepalive()
	return app, nil
}

func (a *App) Close() error {
	if a.keepaliveCancel != nil {
		a.keepaliveCancel()
	}
	if a.db != nil {
		return a.db.Close()
	}
	return nil
}

func (a *App) Handler() http.Handler {
	if os.Getenv(gin.EnvGinMode) == "" {
		gin.SetMode(gin.ReleaseMode)
	}

	router := gin.New()
	router.Use(gin.Logger(), gin.Recovery())

	router.Any("/", gin.WrapF(a.handleIndex))
	router.Any("/scan", gin.WrapF(a.handleScan))
	router.Any("/docs", func(c *gin.Context) {
		c.Redirect(http.StatusMovedPermanently, "/docs/index.html")
	})
	router.Any("/docs/*path", gin.WrapF(a.handleDocs))
	router.Any("/openapi.json", gin.WrapF(a.handleOpenAPI))
	router.Any("/login", gin.WrapF(handleLogin))
	router.Any("/health", func(c *gin.Context) {
		if err := a.db.Ping(c.Request.Context()); err != nil {
			writeError(c.Writer, http.StatusServiceUnavailable, "database unavailable")
			return
		}
		writeJSON(c.Writer, http.StatusOK, gin.H{"ok": true})
	})
	router.GET("/token", func(c *gin.Context) {
		writeJSON(c.Writer, 200, gin.H{"token": ApiToken})
	})
	router.StaticFS("/static", http.Dir(a.resources.Static))
	router.Any("/qr", gin.WrapF(a.handleQRRoot))
	router.Any("/qr/*path", gin.WrapF(a.handleQR))
	router.Any("/accounts", gin.WrapF(a.handleAccountsRoot))
	router.Any("/accounts/health", gin.WrapF(a.handleAccountsHealth))
	router.Any("/accounts/avatar", gin.WrapF(a.handleAccountAvatar))
	router.Any("/accounts/refresh", gin.WrapF(a.handleAccountRefresh))
	router.Any("/accounts/resync", gin.WrapF(a.handleAccountResync))
	router.Any("/accounts/proxy", gin.WrapF(a.handleAccountProxy))
	router.Any("/proxy-profiles", gin.WrapF(a.handleProxyProfiles))
	router.Any("/proxy-profiles/test", gin.WrapF(a.handleProxyProfileTest))
	router.Any("/internal/proxy-url", gin.WrapF(a.handleInternalProxyURL))
	router.Any("/internal/users", gin.WrapF(a.handlePurgeUser))
	router.Any("/wxapp/getCode", gin.WrapF(a.handleGetCode))
	router.Any("/wxapp/getPhoneNumber", gin.WrapF(a.handleGetPhoneNumber))
	router.Any("/wxapp/operateWxData", gin.WrapF(a.handleOperateWXData))
	router.NoRoute(func(c *gin.Context) {
		writeError(c.Writer, http.StatusNotFound, "not found")
	})

	return authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/users" {
			a.userDataMu.RLock()
			defer a.userDataMu.RUnlock()
		}
		if strings.HasPrefix(r.URL.Path, "/accounts") || strings.HasPrefix(r.URL.Path, "/qr") || strings.HasPrefix(r.URL.Path, "/proxy-profiles") || strings.HasPrefix(r.URL.Path, "/wxapp") || strings.HasPrefix(r.URL.Path, "/internal/") {
			role, userID := proxyCaller(r)
			if userID == 0 || (role != "admin" && role != "user") {
				writeError(w, http.StatusForbidden, "valid user identity is required")
				return
			}
			if err := a.db.CheckActiveUser(r.Context(), userID); err != nil {
				writeError(w, http.StatusForbidden, "user is unavailable")
				return
			}
		}
		router.ServeHTTP(w, r)
	}))
}

func (a *App) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	pageData, err := os.ReadFile(filepath.Join(a.resources.Templates, "index.html"))
	pageContent := string(pageData)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load page")
		return
	}
	tokenBlock := `<div id="api-token-section" style="margin:16px;padding:16px;background:#f0f5ff;border:1px solid #d0d7e8;border-radius:8px">
<h3 style="margin:0 0 8px;font-size:16px">API Token</h3>
<code id="api-token" style="display:block;padding:8px 12px;background:#fff;border:1px solid #d9e2ef;border-radius:4px;font-size:13px;word-break:break-all;user-select:all">` + ApiToken + `</code>
<p style="margin:8px 0 0;font-size:13px;color:#667">调用 <code>/wxapp/*</code> 接口时需在请求头添加 <code>Authorization: Bearer &lt;token&gt;</code></p>
</div>`
	if strings.Contains(pageContent, "</body>") {
		pageContent = strings.Replace(pageContent, "</body>", tokenBlock+"</body>", 1)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(pageContent))
}

func (a *App) handleScan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	http.ServeFile(w, r, filepath.Join(a.resources.Templates, "scan.html"))
}

func (a *App) handleDocs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if r.URL.Path == "/docs/" {
		http.Redirect(w, r, "/docs/index.html", http.StatusMovedPermanently)
		return
	}
	swaggerDocsHandler.ServeHTTP(w, r)
}

func (a *App) handleOpenAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	writeRawJSON(w, http.StatusOK, newOpenAPISpec())
}

func (a *App) handleQRRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/qr" {
		writeError(w, http.StatusNotFound, "qr session not found")
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if err := a.pruneQR(); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to remove expired QR")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), a.cfg.RequestTimeout+35*time.Second)
	defer cancel()
	var body struct {
		ProxyMode      string `json:"proxy_mode"`
		ProxyProfileID *int64 `json:"proxy_profile_id"`
	}
	if err := decodeOptionalJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	role, userID := proxyCaller(r)
	proxyMode, tcpProxy, profileID, err := a.resolveRequestedProxy(ctx, body.ProxyMode, body.ProxyProfileID, role, userID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	img, err := a.qr.GetQRCodeImageWithProxy(ctx, proxyMode, tcpProxy, profileID)
	if err != nil {
		writeError(w, http.StatusBadGateway, proxyRequestError(role, tcpProxy, err))
		return
	}
	img.Session.OwnerRole = role
	img.Session.OwnerUserID = userID
	a.mu.Lock()
	a.qrSessions[img.Session.ID] = img.Session
	a.mu.Unlock()
	if err := os.WriteFile(a.resources.qrPath(img.Session.ID), img.ImageBytes, 0600); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save QR image")
		return
	}
	out := map[string]any{
		"session_id":       img.Session.ID,
		"status":           img.Session.Status,
		"image_url":        "/qr/" + img.Session.ID + "/image",
		"proxy_mode":       proxyMode,
		"proxy_profile_id": profileID,
	}
	if r.URL.Query().Get("as_base64") == "true" {
		out["image_base64"] = qr.DataURIJPEG(img.ImageBytes)
	} else {
		out["image_base64"] = nil
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *App) handleQR(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/qr/"), "/")
	if len(parts) != 2 {
		writeError(w, http.StatusNotFound, "qr session not found")
		return
	}
	sessionID, action := parts[0], parts[1]
	switch action {
	case "image":
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		path := a.resources.qrPath(sessionID)
		if _, err := os.Stat(path); err != nil {
			writeError(w, http.StatusNotFound, "qr session not found")
			return
		}
		if !a.qrSessionAllowed(a.getQRSession(sessionID), r) {
			writeError(w, http.StatusForbidden, "二维码会话不属于当前用户")
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		http.ServeFile(w, r, path)
	case "poll":
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		sess := a.getQRSession(sessionID)
		if sess == nil {
			writeError(w, http.StatusNotFound, "qr session not found")
			return
		}
		if !a.qrSessionAllowed(sess, r) {
			writeError(w, http.StatusForbidden, "二维码会话不属于当前用户")
			return
		}
		result, err := a.qr.PollQRCode(r.Context(), sess)
		if err != nil {
			role, _ := proxyCaller(r)
			writeError(w, http.StatusBadGateway, proxyRequestError(role, sess.TCPProxy, err))
			return
		}
		if terminalQR(result.Status) {
			if err := a.dropQRSession(sessionID); err != nil {
				writeError(w, http.StatusInternalServerError, "failed to remove QR")
				return
			}
		}
		writeJSON(w, http.StatusOK, result)
	case "confirm":
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		sess := a.getQRSession(sessionID)
		if sess == nil {
			writeError(w, http.StatusNotFound, "qr session not found")
			return
		}
		if !a.qrSessionAllowed(sess, r) {
			writeError(w, http.StatusForbidden, "二维码会话不属于当前用户")
			return
		}
		result, err := a.qr.GetLoginBuffer(r.Context(), sess)
		if err != nil {
			role, _ := proxyCaller(r)
			writeError(w, http.StatusConflict, proxyRequestError(role, sess.TCPProxy, err))
			return
		}
		var userInfo map[string]any
		loginBuffers := sess.LoginBuffers
		if loginBuffers == nil {
			loginBuffers = a.qr.LoginBuffers()
		}
		if ui, err := loginBuffers.FetchUserInfo(r.Context(), result.Credentials); err == nil {
			userInfo = ui
		}
		acc, err := a.storeFromScan(r.Context(), result.LoginBuffer, result.Credentials, userInfo, sess.TCPProxy, sess.OwnerUserID, sess.OwnerRole)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if sess.ProxyMode != "" {
			role, userID := proxyCaller(r)
			if _, err = a.db.SetAccountProxySetting(r.Context(), acc.ID, sess.ProxyMode, sess.ProxyProfileID, role, userID); err != nil {
				writeError(w, http.StatusInternalServerError, err.Error())
				return
			}
			_ = a.db.InvalidateAllSessions(r.Context(), acc.ID)
		}
		if err := a.dropQRSession(sessionID); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to remove QR")
			return
		}
		writeJSON(w, http.StatusOK, acc.Public())
	default:
		writeError(w, http.StatusNotFound, "qr session not found")
	}
}

func (a *App) handleAccountsRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/accounts" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	switch r.Method {
	case http.MethodGet:
		accounts, err := a.db.ListAccounts(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		out := make([]store.AccountPublic, 0, len(accounts))
		for _, acc := range accounts {
			role, userID := proxyCaller(r)
			if role != "admin" && acc.OwnerUserID != userID {
				continue
			}
			out = append(out, acc.Public())
		}
		writeJSON(w, http.StatusOK, out)
	case http.MethodDelete:
		acc, ok := a.resolveAccountFromQuery(w, r)
		if !ok {
			return
		}
		if err := a.db.DeleteAccount(r.Context(), acc.ID); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"deleted": acc.ID, "openid": acc.OpenID})
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (a *App) handleAccountAvatar(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/accounts/avatar" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	acc, ok := a.resolveAccountFromQuery(w, r)
	if !ok {
		return
	}
	a.serveAvatar(w, r, acc)
}

func (a *App) handleAccountRefresh(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/accounts/refresh" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body accountRefIn
	if err := decodeOptionalJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if body.Ref == "" {
		a.refreshAll(w, r)
		return
	}
	acc, ok := a.resolveAccountRef(w, r, body.Ref)
	if !ok {
		return
	}
	status := a.refreshLiveness(r.Context(), acc)
	writeJSON(w, http.StatusOK, refreshOut(acc, status))
}

func (a *App) handleAccountResync(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/accounts/resync" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body accountRefIn
	if err := decodeOptionalJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if body.Ref == "" {
		a.resyncAll(w, r)
		return
	}
	acc, ok := a.resolveAccountRef(w, r, body.Ref)
	if !ok {
		return
	}
	updated, err := a.resyncProfile(r.Context(), acc)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, updated.Public())
}

func (a *App) handleGetCode(w http.ResponseWriter, r *http.Request) {
	if !acceptWXAppRoute(w, r, "/wxapp/getCode") {
		return
	}
	a.callWXApp(w, r, false, a.invokeGetCode)
}

func (a *App) handleGetPhoneNumber(w http.ResponseWriter, r *http.Request) {
	if !acceptWXAppRoute(w, r, "/wxapp/getPhoneNumber") {
		return
	}
	a.callWXApp(w, r, false, a.invokeGetPhoneNumber)
}

func (a *App) handleOperateWXData(w http.ResponseWriter, r *http.Request) {
	if !acceptWXAppRoute(w, r, "/wxapp/operateWxData") {
		return
	}
	a.callWXApp(w, r, true, a.invokeOperateWXData)
}

func acceptWXAppRoute(w http.ResponseWriter, r *http.Request, path string) bool {
	if r.URL.Path != path {
		writeError(w, http.StatusNotFound, "not found")
		return false
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return false
	}
	return true
}

type accountRefIn struct {
	Ref string `json:"ref"`
}

type wxappRequest struct {
	Ref     string         `json:"ref"`
	AppID   string         `json:"app_id"`
	Payload map[string]any `json:"payload"`
}

type wxappCall func(ctx context.Context, acc *store.WechatAccount, appID string, payload map[string]any) (map[string]any, error)

func (a *App) callWXApp(w http.ResponseWriter, r *http.Request, requirePayload bool, call wxappCall) {
	var body wxappRequest
	raw, _ := io.ReadAll(r.Body)
	r.Body = io.NopCloser(bytes.NewReader(raw))
	if len(raw) > 0 {
		log.Printf("[callWXApp] from %s | body: %s", r.RemoteAddr, string(raw))
		// Farm5 compat: if request has openid/forceRefresh but no ref/app_id/payload,
		// treat as getCode request - force refresh login_buffer first, then get fresh code
		var aux struct {
			OpenID       string `json:"openid"`
			ForceRefresh bool   `json:"forceRefresh"`
		}
		if err := json.Unmarshal(raw, &aux); err == nil && aux.OpenID != "" && body.Ref == "" && body.AppID == "" && body.Payload == nil {
			acc, ok := a.resolveAccountRef(w, r, aux.OpenID)
			if !ok {
				return
			}
			// Force refresh login_buffer first
			proxy, proxyErr := a.accountTCPProxy(r.Context(), acc.ID)
			if proxyErr != nil {
				writeError(w, http.StatusBadGateway, "account proxy unavailable: "+proxyErr.Error())
				return
			}
			_ = a.db.InvalidateSession(r.Context(), acc.ID, proxy)
			status := a.refreshLiveness(r.Context(), acc)
			if status != "alive" {
				if status == "expired" {
					writeError(w, http.StatusConflict, "refresh token rejected; re-scan required")
				} else {
					writeError(w, http.StatusBadGateway, "credential refresh temporarily unavailable; retry later")
				}
				return
			}
			// Re-read fresh account data after refresh
			fresh, err := a.db.GetAccount(r.Context(), acc.ID)
			if err == nil && fresh != nil {
				acc = fresh
			}
			log.Printf("[farm5] got fresh login_buffer, getting code for %s", acc.OpenID)
			// Get a fresh code every time
			result, err := a.pool.GetCode(r.Context(), acc.LoginBuffer, "wx5306c5978fdb76e4", acc.ID, proxy)
			if err != nil {
				role, _ := proxyCaller(r)
				writeError(w, http.StatusBadGateway, proxyRequestError(role, proxy, err))
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"openid": acc.OpenID, "code": result["code"], "result": result})
			return
		}
	}
	if err := decodeOptionalJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if body.Ref == "" {
		accounts, err := a.db.ListAccounts(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if len(accounts) == 1 {
			body.Ref = accounts[0].OpenID
		} else if len(accounts) == 0 {
			writeError(w, http.StatusBadRequest, "no accounts available")
			return
		} else {
			writeError(w, http.StatusBadRequest, "ref is required (multiple accounts found)")
			return
		}
	}
	if body.AppID == "" {
		body.AppID = "wx5306c5978fdb76e4"
	}
	if requirePayload && body.Payload == nil {
		body.Payload = map[string]any{}
	}
	acc, ok := a.resolveAccountRef(w, r, body.Ref)
	if !ok {
		return
	}
	result, err := a.invokeWXApp(r.Context(), acc, body.AppID, body.Payload, call)
	if err != nil {
		var expired accountExpiredError
		switch {
		case errors.As(err, &expired):
			writeError(w, http.StatusConflict, "account login_buffer expired (refresh failed); re-scan required")
		default:
			role, _ := proxyCaller(r)
			proxy, proxyErr := a.accountTCPProxy(r.Context(), acc.ID)
			if proxyErr != nil {
				writeError(w, http.StatusBadGateway, "账号代理配置异常")
				return
			}
			writeError(w, http.StatusBadGateway, proxyRequestError(role, proxy, err))
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"openid": acc.OpenID, "result": result})
}

func decodeOptionalJSON(r *http.Request, dst any) error {
	err := json.NewDecoder(r.Body).Decode(dst)
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

func (a *App) resolveAccountFromQuery(w http.ResponseWriter, r *http.Request) (*store.WechatAccount, bool) {
	ref := strings.TrimSpace(r.URL.Query().Get("ref"))
	if ref == "" {
		writeError(w, http.StatusBadRequest, "ref query param is required")
		return nil, false
	}
	return a.resolveAccountRef(w, r, ref)
}

func (a *App) resolveAccountRef(w http.ResponseWriter, r *http.Request, ref string) (*store.WechatAccount, bool) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		writeError(w, http.StatusBadRequest, "ref is required")
		return nil, false
	}
	role, userID := proxyCaller(r)
	acc, err := a.db.ResolveAccount(r.Context(), ref, role, userID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "account not found: "+ref)
		} else {
			writeError(w, http.StatusInternalServerError, err.Error())
		}
		return nil, false
	}
	if userID == 0 || (role != "admin" && (role != "user" || acc.OwnerUserID != userID)) {
		writeError(w, http.StatusForbidden, "account is unavailable to current user")
		return nil, false
	}
	return acc, true
}

func (a *App) refreshAll(w http.ResponseWriter, r *http.Request) {
	accounts, err := a.db.ListAccounts(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := make([]map[string]any, 0, len(accounts))
	for _, acc := range accounts {
		role, userID := proxyCaller(r)
		if role != "admin" && acc.OwnerUserID != userID {
			continue
		}
		out = append(out, refreshOut(acc, a.refreshLiveness(r.Context(), acc)))
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *App) resyncAll(w http.ResponseWriter, r *http.Request) {
	accounts, err := a.db.ListAccounts(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := make([]store.AccountPublic, 0, len(accounts))
	for _, acc := range accounts {
		role, userID := proxyCaller(r)
		if role != "admin" && acc.OwnerUserID != userID {
			continue
		}
		updated, err := a.resyncProfile(r.Context(), acc)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		out = append(out, updated.Public())
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *App) serveAvatar(w http.ResponseWriter, r *http.Request, acc *store.WechatAccount) {
	if acc.Avatar != nil && *acc.Avatar != "" {
		if _, err := os.Stat(*acc.Avatar); err == nil {
			w.Header().Set("Content-Type", "image/jpeg")
			http.ServeFile(w, r, *acc.Avatar)
			return
		}
		if strings.HasPrefix(*acc.Avatar, "http://") || strings.HasPrefix(*acc.Avatar, "https://") {
			http.Redirect(w, r, *acc.Avatar, http.StatusFound)
			return
		}
	}
	writeError(w, http.StatusNotFound, "no avatar")
}

func (a *App) storeFromScan(ctx context.Context, loginBuffer string, creds protocol.LoginBufferCredentials, userInfo map[string]any, tcpProxy string, ownerUserID int64, ownerRole string) (*store.WechatAccount, error) {
	openid := creds.OpenID
	nick := pickNickname(userInfo, creds.Nickname)
	avatar := a.resolveAvatar(ctx, ownerUserID, openid, userInfo, tcpProxy)
	status := "alive"
	acc, err := a.db.UpsertAccount(ctx, openid, loginBuffer, ownerUserID, ownerRole, stringPtrMaybe(nick), stringPtrMaybe(nick), stringPtrMaybe(avatar), userInfo, creds.ToMap(), &status)
	if err == nil {
		_ = a.db.RecordRefresh(ctx, acc.ID, "", false)
	}
	return acc, err
}

func (a *App) refreshLiveness(ctx context.Context, acc *store.WechatAccount) string {
	status, _ := a.refreshLivenessResult(ctx, acc)
	return status
}

func (a *App) refreshLivenessResult(ctx context.Context, acc *store.WechatAccount) (string, error) {
	lock, _ := a.refreshLocks.LoadOrStore(acc.ID, make(chan struct{}, 1))
	gate := lock.(chan struct{})
	select {
	case gate <- struct{}{}:
		defer func() { <-gate }()
	case <-ctx.Done():
		return "retry", ctx.Err()
	}
	// A previous refresh or re-scan may have rotated credentials while we waited.
	fresh, err := a.db.GetAccount(ctx, acc.ID)
	if err != nil {
		return "retry", errors.New("failed to read account credentials")
	}
	acc = fresh
	if deref(acc.Status) == "expired" {
		return "expired", accountExpiredError{openid: acc.OpenID}
	}
	if acc.Credentials == nil {
		_ = a.db.SetAccountStatus(ctx, acc.ID, "unknown")
		return "unknown", errors.New("account credentials unavailable")
	}
	creds := protocol.CredentialsFromMap(acc.Credentials)
	proxy, proxyErr := a.accountTCPProxy(ctx, acc.ID)
	if proxyErr != nil {
		_ = a.db.SetAccountStatus(ctx, acc.ID, "proxy_error")
		_ = a.db.RecordRefresh(ctx, acc.ID, "代理配置不可用，请检查账号代理设置", true)
		return "proxy_error", errors.New("account proxy unavailable; check proxy settings")
	}
	result, err := a.qr.RefreshLoginBufferWithProxy(ctx, creds, proxy)
	if err != nil {
		if saveErr := a.preserveRotatedCredentials(ctx, acc, result); saveErr != nil {
			return a.recordRefreshFailure(ctx, acc, errors.New("failed to persist rotated credentials"))
		}
		return a.recordRefreshFailure(ctx, acc, err)
	}
	if err := a.db.SetAccountCredential(ctx, acc.ID, result.LoginBuffer, result.Credentials.ToMap()); err != nil {
		return "retry", err
	}
	if err := a.db.SetAccountStatus(ctx, acc.ID, "alive"); err != nil {
		return "retry", err
	}
	_ = a.db.RecordRefresh(ctx, acc.ID, "", false)
	if avatar := a.resolveAvatar(ctx, acc.OwnerUserID, acc.OpenID, acc.UserInfo, proxy); avatar != "" {
		_ = a.db.SetAccountProfile(ctx, acc.ID, acc.Nickname, &avatar, acc.UserInfo)
	}
	return "alive", nil
}

func (a *App) resyncProfile(ctx context.Context, acc *store.WechatAccount) (*store.WechatAccount, error) {
	nick := pickNickname(acc.UserInfo, deref(acc.Nickname))
	proxy, err := a.accountTCPProxy(ctx, acc.ID)
	if err != nil {
		return nil, err
	}
	avatar := a.resolveAvatar(ctx, acc.OwnerUserID, acc.OpenID, acc.UserInfo, proxy)
	if avatar == "" {
		avatar = deref(acc.Avatar)
	}
	if err := a.db.SetAccountProfile(ctx, acc.ID, stringPtrMaybe(nick), stringPtrMaybe(avatar), acc.UserInfo); err != nil {
		return nil, err
	}
	return a.db.GetAccount(ctx, acc.ID)
}

type accountExpiredError struct{ openid string }

func (e accountExpiredError) Error() string { return "account expired: " + e.openid }

func (a *App) invokeWXApp(ctx context.Context, acc *store.WechatAccount, appID string, payload map[string]any, call wxappCall) (map[string]any, error) {
	if acc.Status != nil && *acc.Status == "expired" {
		return nil, accountExpiredError{openid: acc.OpenID}
	}
	proxy, err := a.accountTCPProxy(ctx, acc.ID)
	if err != nil {
		return nil, err
	}
	if _, err := a.db.GetSession(ctx, acc.ID, proxy); err == nil {
		result, err := call(ctx, acc, appID, payload)
		if err == nil {
			return result, nil
		}
		if temporaryProtocolError(err) {
			return nil, err
		}
		_ = a.db.InvalidateSession(ctx, acc.ID, proxy)
	}
	status, refreshErr := a.refreshLivenessResult(ctx, acc)
	if status != "alive" {
		if status == "expired" {
			return nil, accountExpiredError{openid: acc.OpenID}
		}
		return nil, refreshErr
	}
	fresh, err := a.db.GetAccount(ctx, acc.ID)
	if err == nil && fresh != nil {
		acc = fresh
	}
	return call(ctx, acc, appID, payload)
}

func (a *App) invokeGetCode(ctx context.Context, acc *store.WechatAccount, appID string, _ map[string]any) (map[string]any, error) {
	proxy, err := a.accountTCPProxy(ctx, acc.ID)
	if err != nil {
		return nil, err
	}
	return a.pool.GetCode(ctx, acc.LoginBuffer, appID, acc.ID, proxy)
}

func (a *App) invokeGetPhoneNumber(ctx context.Context, acc *store.WechatAccount, appID string, _ map[string]any) (map[string]any, error) {
	proxy, err := a.accountTCPProxy(ctx, acc.ID)
	if err != nil {
		return nil, err
	}
	return a.pool.GetPhoneNumber(ctx, acc.LoginBuffer, appID, acc.ID, proxy)
}

func (a *App) invokeOperateWXData(ctx context.Context, acc *store.WechatAccount, appID string, payload map[string]any) (map[string]any, error) {
	proxy, err := a.accountTCPProxy(ctx, acc.ID)
	if err != nil {
		return nil, err
	}
	return a.pool.OperateWXData(ctx, acc.LoginBuffer, appID, payload, acc.ID, proxy)
}

func (a *App) accountTCPProxy(ctx context.Context, accountID int64) (string, error) {
	proxy, err := a.db.ResolveAccountTCPProxy(ctx, accountID)
	if err != nil {
		return "", err
	}
	return proxy, nil
}

func refreshOut(acc *store.WechatAccount, status string) map[string]any {
	return map[string]any{"id": acc.ID, "openid": acc.OpenID, "uin": acc.UIN, "nickname": acc.Nickname, "status": status}
}

func pickNickname(userInfo map[string]any, fallback string) string {
	if s := stringFromAny(userInfo["nick_name"]); s != "" {
		return s
	}
	return fallback
}

func pickAvatarURL(userInfo map[string]any) string {
	for _, k := range []string{"head_img_url", "head_url", "headimgurl", "avatar"} {
		if s := stringFromAny(userInfo[k]); s != "" {
			return s
		}
	}
	return ""
}

func (a *App) resolveAvatar(ctx context.Context, userID int64, openid string, userInfo map[string]any, tcpProxy string) string {
	u := pickAvatarURL(userInfo)
	if u == "" {
		return ""
	}
	dest := a.resources.avatarPath(userID, openid)
	if downloadAvatar(ctx, u, dest, a.cfg.AvatarTimeout, tcpProxy) {
		return dest
	}
	return u
}

func downloadAvatar(ctx context.Context, url, dest string, timeout time.Duration, tcpProxy string) bool {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	client, err := protocol.NewHTTPClient(timeout, tcpProxy)
	if err != nil {
		return false
	}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil || resp.StatusCode != 200 || !looksLikeImage(data) {
		return false
	}
	_ = os.MkdirAll(filepath.Dir(dest), 0o755)
	return os.WriteFile(dest, data, 0o644) == nil
}

func looksLikeImage(data []byte) bool {
	if len(data) < 64 {
		return false
	}
	magics := [][]byte{{0xff, 0xd8, 0xff}, {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, []byte("GIF87a"), []byte("GIF89a")}
	for _, m := range magics {
		if strings.HasPrefix(string(data), string(m)) {
			return true
		}
	}
	return false
}

func (a *App) getQRSession(id string) *qr.Session {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.qrSessions[id]
}

func (a *App) qrSessionAllowed(sess *qr.Session, r *http.Request) bool {
	if sess == nil {
		return false
	}
	role, userID := proxyCaller(r)
	if role == "admin" {
		return true
	}
	return sess.OwnerRole != "admin" && sess.OwnerUserID >= 1000 && sess.OwnerUserID == userID
}

func (a *App) dropQRSession(id string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := os.Remove(a.resources.qrPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	delete(a.qrSessions, id)
	return nil
}

func (a *App) pruneQR() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	for id, sess := range a.qrSessions {
		if sess.Age() <= a.cfg.QRSessionTTL {
			continue
		}
		if err := os.Remove(a.resources.qrPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		delete(a.qrSessions, id)
	}
	return nil
}

func (a *App) cleanupQR(keep map[string]bool) error {
	files, err := filepath.Glob(filepath.Join(a.resources.QR, "*.jpg"))
	if err != nil {
		return err
	}
	for _, file := range files {
		id := strings.TrimSuffix(filepath.Base(file), ".jpg")
		if !keep[id] {
			if err := os.Remove(file); err != nil {
				return err
			}
		}
	}
	return nil
}

func terminalQR(status string) bool {
	return status == "expired" || status == "cancelled"
}

type apiEnvelope struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
	Data any    `json:"data"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	writeRawJSON(w, status, apiEnvelope{
		Code: 0,
		Msg:  "success",
		Data: v,
	})
}

func writeRawJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func writeError(w http.ResponseWriter, status int, detail string) {
	writeRawJSON(w, status, apiEnvelope{
		Code: status,
		Msg:  detail,
		Data: nil,
	})
}

func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
	})
}

func stringFromAny(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func stringPtrMaybe(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func safeName(s string) string {
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func sortedKeys[M ~map[string]V, V any](m M) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func (a *App) handlePurgeUser(w http.ResponseWriter, r *http.Request) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	role, _ := proxyCaller(r)
	if err != nil || !net.ParseIP(host).IsLoopback() || ApiToken == "" || r.Header.Get("Authorization") != "Bearer "+ApiToken || role != "admin" {
		writeError(w, http.StatusForbidden, "local administrator authentication required")
		return
	}
	if r.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var body struct {
		UserID int64 `json:"userId"`
	}
	if err := decodeOptionalJSON(r, &body); err != nil || body.UserID <= 1000 {
		writeError(w, http.StatusBadRequest, "userID is required")
		return
	}
	a.userDataMu.Lock()
	defer a.userDataMu.Unlock()
	accounts, err := a.db.ListAccounts(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	accountIDs := []int64{}
	// Files are removed while account rows still exist, so a failed cleanup is retryable.
	for _, account := range accounts {
		if account.OwnerUserID != body.UserID {
			continue
		}
		accountIDs = append(accountIDs, account.ID)
		if err := os.Remove(a.resources.avatarPath(account.OwnerUserID, account.OpenID)); err != nil && !errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusInternalServerError, "failed to remove user avatar")
			return
		}
	}
	a.mu.Lock()
	for id, session := range a.qrSessions {
		if session.OwnerUserID == body.UserID {
			if err := os.Remove(a.resources.qrPath(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
				a.mu.Unlock()
				writeError(w, http.StatusInternalServerError, "failed to remove user QR")
				return
			}
			delete(a.qrSessions, id)
		}
	}
	a.mu.Unlock()
	if _, err := a.db.PurgeUser(r.Context(), body.UserID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to remove user data")
		return
	}
	a.pool.ForgetAccounts(accountIDs)
	for _, id := range accountIDs {
		a.refreshLocks.Delete(id)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}
