package protocol

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strings"
	"time"
)

const (
	yybHost         = "https://yybadaccess.3g.qq.com"
	loginBufferURL  = yybHost + "/pc_yyb_auth/pcyyb_get_wx_login_buffer_auth"
	refreshTokenURL = yybHost + "/pc_yyb_auth/pcyyb_refresh_token_auth"
	userInfoURL     = yybHost + "/pc_yyb/pcyyb_get_user_info"
	loginBusinessID = "pc_yyb_auth"
	loginAccessKey  = "wgrdg373hy26ww2"
)

type LoginBufferCredentials struct {
	OpenID       string `json:"openid"`
	AccessToken  string `json:"accesstoken"`
	RefreshToken string `json:"refreshtoken"`
	LoginType    string `json:"logintype"`
	Nickname     string `json:"nickname"`
	ExpiresAt    int64  `json:"expires_at"`
	ExpiresIn    int64  `json:"expires_in"`
}

type RefreshRejectedError struct{ Code int }

// ProtocolError exposes only an allowlisted stage, category and numeric codes.
type ProtocolError struct {
	Stage      string
	Kind       string
	Code       int
	HTTPStatus int
	Cause      error
}

func (e ProtocolError) Error() string {
	return fmt.Sprintf("credential protocol failure: stage=%s kind=%s code=%d http=%d", e.Stage, e.Kind, e.Code, e.HTTPStatus)
}

func (e ProtocolError) Unwrap() error { return e.Cause }

func (e RefreshRejectedError) Error() string {
	return fmt.Sprintf("refresh token rejected: code=%d", e.Code)
}

func refreshRejection(code int, message string) bool {
	if code == 40030 || code == 42002 {
		return true
	}
	message = strings.ToLower(message)
	mentionsToken := strings.Contains(message, "refresh_token") || strings.Contains(message, "refresh token") || strings.Contains(message, "refreshtoken")
	return mentionsToken && (strings.Contains(message, "invalid") || strings.Contains(message, "expired") || strings.Contains(message, "revoked") || strings.Contains(message, "无效") || strings.Contains(message, "过期"))
}

func CredentialsFromMap(m map[string]any) LoginBufferCredentials {
	return LoginBufferCredentials{
		OpenID:       stringFromMap(m, "openid"),
		AccessToken:  stringFromMap(m, "accesstoken"),
		RefreshToken: stringFromMap(m, "refreshtoken"),
		LoginType:    defaultString(stringFromMap(m, "logintype"), "WX"),
		Nickname:     stringFromMap(m, "nickname"),
		ExpiresAt:    int64FromMap(m, "expires_at"),
		ExpiresIn:    defaultInt64(int64FromMap(m, "expires_in"), 7200),
	}
}

func (c LoginBufferCredentials) ToMap() map[string]any {
	return map[string]any{
		"openid":               c.OpenID,
		"accesstoken":          c.AccessToken,
		"refreshtoken":         c.RefreshToken,
		"logintype":            defaultString(c.LoginType, "WX"),
		"nickname":             c.Nickname,
		"expires_at":           c.ExpiresAt,
		"expires_in":           defaultInt64(c.ExpiresIn, 7200),
		"refresh_refreshed_at": time.Now().Unix(),
	}
}

func (c LoginBufferCredentials) Expired(skew time.Duration) bool {
	return time.Now().Add(skew).Unix() >= c.ExpiresAt
}

type LoginBufferResult struct {
	LoginBuffer string
	Credentials LoginBufferCredentials
	Refreshed   bool
}

type LoginBufferClient struct {
	httpClient *http.Client
	timeout    time.Duration
}

func NewLoginBufferClient(timeout time.Duration) *LoginBufferClient {
	client, _ := NewHTTPClient(timeout, "")
	return &LoginBufferClient{
		httpClient: client,
		timeout:    timeout,
	}
}

func NewLoginBufferClientWithProxy(timeout time.Duration, tcpProxy string) (*LoginBufferClient, error) {
	client, err := NewHTTPClient(timeout, tcpProxy)
	if err != nil {
		return nil, err
	}
	return &LoginBufferClient{httpClient: client, timeout: timeout}, nil
}

func (c *LoginBufferClient) FetchLoginBuffer(ctx context.Context, creds LoginBufferCredentials) (string, error) {
	body, err := json.Marshal(loginBufferRequest{
		ExtInfo: loginExtInfo{
			ListS: loginListS{
				UnionID:     loginValueString{Value: []string{creds.OpenID}},
				UserID:      loginValueString{Value: []string{creds.OpenID}},
				AccessToken: loginValueString{Value: []string{creds.AccessToken}},
			},
			ListI: loginListI{UserType: loginValueInt{Value: []int{0}}},
		},
	})
	if err != nil {
		return "", err
	}
	ts, nonce := timestampMS(), nonce4()
	var data map[string]any
	if err = c.requestJSON(ctx, http.MethodPost, loginBufferURL, body, map[string]string{
		"Content-Type":          "application/json",
		"Ual-Access-Businessid": loginBusinessID,
		"Ual-Access-Timestamp":  ts,
		"Ual-Access-Nonce":      nonce,
		"Ual-Access-Signature":  sign(string(body), nonce, ts, loginAccessKey),
		"Cookie":                fmt.Sprintf("openid=%s; accesstoken=%s; refreshtoken=%s", creds.OpenID, creds.AccessToken, creds.RefreshToken),
	}, &data); err != nil {
		return "", err
	}
	if intFromAny(data["code"]) != 0 {
		return "", ProtocolError{Stage: "login_buffer", Kind: "business", Code: intFromAny(data["code"])}
	}
	values := stringSlicePath(data, "ext_info", "list_s", "login_buffer", "value")
	if len(values) == 0 || values[0] == "" {
		return "", ProtocolError{Stage: "login_buffer", Kind: "empty"}
	}
	return values[0], nil
}

func (c *LoginBufferClient) RefreshCredentials(ctx context.Context, creds LoginBufferCredentials) (LoginBufferCredentials, error) {
	if creds.RefreshToken == "" {
		return LoginBufferCredentials{}, ProtocolError{Stage: "refresh_token", Kind: "missing"}
	}
	body, err := json.Marshal(refreshTokenRequest{UserInfo: refreshTokenUserInfo{
		OpenID:       creds.OpenID,
		RefreshToken: creds.RefreshToken,
		AccessToken:  creds.AccessToken,
		LoginType:    defaultString(creds.LoginType, "WX"),
	}})
	if err != nil {
		return LoginBufferCredentials{}, err
	}
	ts, nonce := timestampMS(), nonce4()
	var data map[string]any
	if err = c.requestJSON(ctx, http.MethodPost, refreshTokenURL, body, map[string]string{
		"Content-Type":          "application/json",
		"Ual-Access-Businessid": loginBusinessID,
		"Ual-Access-Timestamp":  ts,
		"Ual-Access-Nonce":      nonce,
		"Ual-Access-Signature":  sign(string(body), nonce, ts, loginAccessKey),
	}, &data); err != nil {
		return LoginBufferCredentials{}, err
	}
	if intFromAny(data["code"]) != 0 {
		if refreshRejection(intFromAny(data["code"]), fmt.Sprint(data["msg"])) {
			return LoginBufferCredentials{}, RefreshRejectedError{Code: intFromAny(data["code"])}
		}
		return LoginBufferCredentials{}, ProtocolError{Stage: "refresh_token", Kind: "business", Code: intFromAny(data["code"])}
	}
	info, _ := data["user_info"].(map[string]any)
	expiresIn := defaultInt64(int64FromMap(info, "expires_in"), 7200)
	refreshed := creds
	refreshed.AccessToken = stringFromMap(info, "access_token")
	if rt := stringFromMap(info, "refresh_token"); rt != "" {
		refreshed.RefreshToken = rt
	}
	refreshed.ExpiresIn = expiresIn
	refreshed.ExpiresAt = time.Now().Unix() + expiresIn
	if refreshed.AccessToken == "" {
		return LoginBufferCredentials{}, ProtocolError{Stage: "refresh_token", Kind: "empty"}
	}
	return refreshed, nil
}

func (c *LoginBufferClient) RefreshLoginBuffer(ctx context.Context, creds LoginBufferCredentials) (LoginBufferResult, error) {
	refreshed, err := c.RefreshCredentials(ctx, creds)
	if err != nil {
		return LoginBufferResult{}, err
	}
	lb, err := c.FetchLoginBuffer(ctx, refreshed)
	if err != nil {
		return LoginBufferResult{Credentials: refreshed, Refreshed: true}, err
	}
	return LoginBufferResult{LoginBuffer: lb, Credentials: refreshed, Refreshed: true}, nil
}

func (c *LoginBufferClient) FetchUserInfo(ctx context.Context, creds LoginBufferCredentials) (map[string]any, error) {
	ts, nonce := timestampMS(), nonce4()
	var data map[string]any
	err := c.requestJSON(ctx, http.MethodGet, userInfoURL, nil, map[string]string{
		"Ual-Access-Access-Token": creds.AccessToken,
		"Ual-Access-Login-Type":   "2",
		"Ual-Access-Openid":       creds.OpenID,
		"Ual-Access-Businessid":   "pc_yyb",
		"Ual-Access-Guid":         "web",
		"Ual-Access-Nonce":        nonce,
		"Ual-Access-Requestid":    fmt.Sprintf("%d", rand.Intn(9000)+1000),
		"Ual-Access-Signature":    sign("", nonce, ts, ""),
		"Ual-Access-Timestamp":    ts,
	}, &data)
	if err != nil {
		return nil, err
	}
	return data, nil
}

func (c *LoginBufferClient) requestJSON(ctx context.Context, method, url string, body []byte, headers map[string]string, out any) error {
	stage := "user_info"
	if url == refreshTokenURL {
		stage = "refresh_token"
	}
	if url == loginBufferURL {
		stage = "login_buffer"
	}
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, rdr)
	if err != nil {
		return ProtocolError{Stage: stage, Kind: "request", Cause: err}
	}
	req.Header.Set("Accept", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return ProtocolError{Stage: stage, Kind: "transport", Cause: err}
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return ProtocolError{Stage: stage, Kind: "read", Cause: err}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ProtocolError{Stage: stage, Kind: "http", HTTPStatus: resp.StatusCode}
	}
	if err = json.Unmarshal(data, out); err != nil {
		return ProtocolError{Stage: stage, Kind: "decode"}
	}
	return nil
}

type loginBufferRequest struct {
	ExtInfo loginExtInfo `json:"extInfo"`
}
type loginExtInfo struct {
	ListS loginListS `json:"listS"`
	ListI loginListI `json:"listI"`
}
type loginListS struct {
	UnionID     loginValueString `json:"unionid"`
	UserID      loginValueString `json:"user_id"`
	AccessToken loginValueString `json:"access_token"`
}
type loginListI struct {
	UserType loginValueInt `json:"user_type"`
}
type loginValueString struct {
	Value []string `json:"value"`
}
type loginValueInt struct {
	Value []int `json:"value"`
}
type refreshTokenRequest struct {
	UserInfo refreshTokenUserInfo `json:"userInfo"`
}
type refreshTokenUserInfo struct {
	OpenID       string `json:"openId"`
	RefreshToken string `json:"refreshToken"`
	AccessToken  string `json:"accessToken"`
	LoginType    string `json:"loginType"`
}

func timestampMS() string {
	return fmt.Sprintf("%d", time.Now().UnixMilli())
}

func nonce4() string {
	return fmt.Sprintf("%d", rand.Intn(10000))
}

func sign(body, nonce, ts, key string) string {
	sum := md5.Sum([]byte(body + ts + key + nonce))
	return hex.EncodeToString(sum[:])
}

func stringSlicePath(m map[string]any, path ...string) []string {
	var cur any = m
	for _, p := range path {
		obj, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = obj[p]
	}
	arr, ok := cur.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, v := range arr {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func stringFromMap(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	if s, ok := m[key].(string); ok {
		return s
	}
	return ""
}

func int64FromMap(m map[string]any, key string) int64 {
	if m == nil {
		return 0
	}
	switch v := m[key].(type) {
	case int:
		return int64(v)
	case int64:
		return v
	case float64:
		return int64(v)
	case json.Number:
		n, _ := v.Int64()
		return n
	default:
		return 0
	}
}

func intFromAny(v any) int {
	switch x := v.(type) {
	case int:
		return x
	case int64:
		return int(x)
	case float64:
		return int(x)
	case json.Number:
		n, _ := x.Int64()
		return int(n)
	default:
		return 0
	}
}

func defaultString(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func defaultInt64(v, def int64) int64 {
	if v == 0 {
		return def
	}
	return v
}
