package protocol

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"time"
)

// NewHTTPClient builds an HTTP client whose TCP dials use the same strict
// HTTP CONNECT/SOCKS5 path as LongLink and ShortLink. A configured proxy never
// falls back to direct connectivity.
func NewHTTPClient(timeout time.Duration, proxyValue string) (*http.Client, error) {
	parsed, err := parseTCPProxy(proxyValue)
	if err != nil {
		return nil, err
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, portText, splitErr := net.SplitHostPort(address)
		if splitErr != nil {
			return nil, splitErr
		}
		port, parseErr := net.LookupPort("tcp", portText)
		if parseErr != nil {
			return nil, parseErr
		}
		if parsed == nil {
			return dialDirect(ctx, host, port, timeout)
		}
		return dialViaProxy(ctx, parsed, host, port, timeout)
	}
	transport.DialTLSContext = nil
	return &http.Client{Timeout: timeout, Transport: transport}, nil
}

func NormalizeTCPProxy(value string) (string, error) {
	parsed, err := parseTCPProxy(value)
	if err != nil || parsed == nil {
		return value, err
	}
	u := &url.URL{Scheme: parsed.Scheme, Host: net.JoinHostPort(parsed.Host, parsed.Port), User: parsed.User}
	if u.Scheme != "socks5" && u.Scheme != "http-connect" {
		return "", fmt.Errorf("unsupported proxy protocol")
	}
	return u.String(), nil
}
