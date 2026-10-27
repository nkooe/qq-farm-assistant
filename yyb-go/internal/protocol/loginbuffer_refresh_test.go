package protocol

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

type refreshTestTransport func(*http.Request) (*http.Response, error)

func (f refreshTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestRefreshClassifiesTokenRejectionWithoutExpiringOnServiceErrors(t *testing.T) {
	for _, tc := range []struct {
		body     string
		rejected bool
	}{
		{`{"code":40030,"msg":"invalid refresh_token"}`, true},
		{`{"code":42002,"msg":"refresh_token expired"}`, true},
		{`{"code":500,"msg":"busy, retry later"}`, false},
		{`{"code":-1,"msg":"upstream unavailable"}`, false},
	} {
		client := &LoginBufferClient{httpClient: &http.Client{Transport: refreshTestTransport(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(tc.body)), Header: make(http.Header)}, nil
		})}}
		_, err := client.RefreshCredentials(context.Background(), LoginBufferCredentials{OpenID: "test", RefreshToken: "secret"})
		var rejected RefreshRejectedError
		if err == nil || errors.As(err, &rejected) != tc.rejected {
			t.Fatalf("body=%s err=%v", tc.body, err)
		}
	}
}

func TestRefreshReturnsRotatedCredentialsWhenLoginBufferFails(t *testing.T) {
	client := &LoginBufferClient{httpClient: &http.Client{Transport: refreshTestTransport(func(r *http.Request) (*http.Response, error) {
		body := `{"code":0,"user_info":{"access_token":"new-access","refresh_token":"new-refresh","expires_in":7200}}`
		if r.URL.String() == loginBufferURL {
			body = `{"code":500,"msg":"secret-refresh https://proxy:password@example.test"}`
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}, nil
	})}}
	result, err := client.RefreshLoginBuffer(context.Background(), LoginBufferCredentials{OpenID: "test", RefreshToken: "old"})
	var diagnostic ProtocolError
	if !errors.As(err, &diagnostic) || diagnostic.Stage != "login_buffer" || diagnostic.Code != 500 {
		t.Fatalf("diagnostic=%v", err)
	}
	if !result.Refreshed || result.Credentials.RefreshToken != "new-refresh" || result.LoginBuffer != "" {
		t.Fatal("rotated credentials were lost")
	}
	if strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "password") {
		t.Fatal("upstream response leaked")
	}
}

func TestCredentialProtocolErrorsExposeOnlySafeDiagnostics(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
		kind   string
	}{
		{502, "refresh_token=secret https://user:password@example.test", "http"},
		{200, "refresh_token=secret not JSON", "decode"},
		{200, `{"code":500,"msg":"refresh_token=secret"}`, "business"},
	} {
		client := &LoginBufferClient{httpClient: &http.Client{Transport: refreshTestTransport(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: tc.status, Body: io.NopCloser(strings.NewReader(tc.body)), Header: make(http.Header)}, nil
		})}}
		_, err := client.RefreshCredentials(context.Background(), LoginBufferCredentials{RefreshToken: "secret"})
		var diagnostic ProtocolError
		if !errors.As(err, &diagnostic) || diagnostic.Stage != "refresh_token" || diagnostic.Kind != tc.kind {
			t.Fatalf("diagnostic=%v", err)
		}
		if strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "password") {
			t.Fatal("sensitive data leaked")
		}
	}
}
