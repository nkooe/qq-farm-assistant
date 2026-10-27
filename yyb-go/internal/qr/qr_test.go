package qr

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type pollTransport func(*http.Request) (*http.Response, error)

func (f pollTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestPollQRCodeScanConfirmationSequence(t *testing.T) {
	steps := []struct {
		body, want, last string
	}{
		{`window.wx_errcode=408;window.wx_code='';`, "pending", ""},
		{`window.wx_errcode=404;window.wx_code='';`, "scanned", ""},
		{`window.wx_errcode=408;window.wx_code='';`, "scanned", "404"},
		{`unexpected response`, "unknown", "404"},
		{`window.wx_errcode=408;window.wx_code='';`, "scanned", "404"},
		{`window.wx_errcode="405";window.wx_code="oauth-test-code";`, "authorized", "404"},
	}
	index := 0
	sess := &Session{WXUUID: "test-uuid", Status: "pending"}
	sess.HTTPClient = &http.Client{Transport: pollTransport(func(r *http.Request) (*http.Response, error) {
		step := steps[index]
		if r.URL.Query().Get("uuid") != "test-uuid" || r.URL.Query().Get("last") != step.last {
			t.Fatalf("step %d: unexpected poll query %v", index, r.URL.Query())
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(step.body)), Header: make(http.Header)}, nil
	})}
	client := NewClient(time.Second)
	for index = range steps {
		got, err := client.PollQRCode(context.Background(), sess)
		if err != nil || got.Status != steps[index].want {
			t.Fatalf("step %d: got %v, %v; want %s", index, got, err, steps[index].want)
		}
		if index < len(steps)-1 && sess.AuthorizeCode != "" {
			t.Fatalf("step %d: authorized before phone confirmation", index)
		}
	}
	if sess.AuthorizeCode != "oauth-test-code" {
		t.Fatal("authorization code was not retained")
	}
}

func TestPollQRCodeTimeoutAndCancellation(t *testing.T) {
	for _, status := range []string{"pending", "scanned"} {
		sess := &Session{Status: status, HTTPClient: &http.Client{Transport: pollTransport(func(r *http.Request) (*http.Response, error) {
			return nil, context.DeadlineExceeded
		})}}
		got, err := NewClient(time.Second).PollQRCode(context.Background(), sess)
		if err != nil || got.Status != status {
			t.Fatalf("timeout lost %s state: %v, %v", status, got, err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := NewClient(time.Second).PollQRCode(ctx, sess); err == nil {
			t.Fatal("caller cancellation must stop polling")
		}
	}
}

func TestPollQRCodeRejectsUpstreamHTTPError(t *testing.T) {
	sess := &Session{Status: "pending", HTTPClient: &http.Client{Transport: pollTransport(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusServiceUnavailable, Body: io.NopCloser(strings.NewReader("service unavailable")), Header: make(http.Header)}, nil
	})}}
	if _, err := NewClient(time.Second).PollQRCode(context.Background(), sess); err == nil {
		t.Fatal("HTTP failure must not be treated as QR expiry or a scan event")
	}
}

func TestClassifyPoll(t *testing.T) {
	tests := []struct {
		name    string
		errCode *int
		code    string
		want    string
	}{
		{name: "waiting", errCode: intPtr(408), want: "pending"},
		{name: "scanned", errCode: intPtr(404), want: "scanned"},
		{name: "cancelled", errCode: intPtr(403), want: "cancelled"},
		{name: "expired", errCode: intPtr(402), want: "expired"},
		{name: "authorized", errCode: intPtr(405), code: "oauth-code", want: "authorized"},
		{name: "authorization without code is unknown", errCode: intPtr(405), want: "unknown"},
		{name: "unrecognized code is unknown", errCode: intPtr(500), want: "unknown"},
		{name: "missing code is unknown", want: "unknown"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := classifyPoll(tt.errCode, tt.code); got != tt.want {
				t.Fatalf("classifyPoll(%v, %q) = %q, want %q", tt.errCode, tt.code, got, tt.want)
			}
		})
	}
}

func intPtr(v int) *int { return &v }
