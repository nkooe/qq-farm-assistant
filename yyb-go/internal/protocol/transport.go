package protocol

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type tcpProxy struct {
	Scheme string
	Host   string
	Port   string
	User   *url.Userinfo
}

func parseTCPProxy(value string) (*tcpProxy, error) {
	if value == "" {
		return nil, nil
	}
	u, err := url.Parse(value)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "socks5" && u.Scheme != "http-connect" {
		return nil, fmt.Errorf("tcp_proxy must use socks5:// or http-connect://")
	}
	if u.Hostname() == "" || u.Port() == "" {
		return nil, fmt.Errorf("tcp_proxy must include host and port")
	}
	return &tcpProxy{Scheme: u.Scheme, Host: u.Hostname(), Port: u.Port(), User: u.User}, nil
}

func dialTCP(ctx context.Context, host string, port int, timeout time.Duration, proxyValue string, fallbackDirect bool) (net.Conn, error) {
	proxy, err := parseTCPProxy(proxyValue)
	if err != nil {
		return nil, err
	}
	if proxy == nil {
		return dialDirect(ctx, host, port, timeout)
	}
	conn, err := dialViaProxy(ctx, proxy, host, port, timeout)
	if err == nil {
		return conn, nil
	}
	if !fallbackDirect {
		return nil, err
	}
	return dialDirect(ctx, host, port, timeout)
}

func dialDirect(ctx context.Context, host string, port int, timeout time.Duration) (net.Conn, error) {
	var d net.Dialer
	if timeout > 0 {
		d.Timeout = timeout
	}
	return d.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
}

func dialViaProxy(ctx context.Context, proxy *tcpProxy, targetHost string, targetPort int, timeout time.Duration) (net.Conn, error) {
	conn, err := dialDirect(ctx, proxy.Host, mustAtoi(proxy.Port), timeout)
	if err != nil {
		return nil, fmt.Errorf("dial proxy failed: %w", err)
	}
	deadline := time.Time{}
	if timeout > 0 {
		deadline = time.Now().Add(timeout)
	}
	if ctxDeadline, ok := ctx.Deadline(); ok && (deadline.IsZero() || ctxDeadline.Before(deadline)) {
		deadline = ctxDeadline
	}
	if !deadline.IsZero() {
		_ = conn.SetDeadline(deadline)
	}
	// A TCP connection can succeed while the proxy handshake stalls. Propagate
	// context cancellation to the blocking read/write and wait for the callback
	// before clearing the temporary deadline.
	cancelFinished := make(chan struct{})
	stopCancel := context.AfterFunc(ctx, func() {
		_ = conn.SetDeadline(time.Now())
		close(cancelFinished)
	})
	if proxy.Scheme == "socks5" {
		err = socks5Connect(conn, proxy.User, targetHost, targetPort)
	} else {
		err = httpConnect(conn, proxy.User, targetHost, targetPort)
	}
	if !stopCancel() {
		<-cancelFinished
	}
	_ = conn.SetDeadline(time.Time{})
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("%s proxy handshake to %s failed: %w", proxy.Scheme, net.JoinHostPort(targetHost, strconv.Itoa(targetPort)), err)
	}
	return conn, nil
}

func socks5Connect(conn net.Conn, userInfo *url.Userinfo, targetHost string, targetPort int) error {
	methods := []byte{0x00}
	if userInfo != nil && userInfo.Username() != "" {
		methods = append(methods, 0x02)
	}
	if _, err := conn.Write(append([]byte{0x05, byte(len(methods))}, methods...)); err != nil {
		return err
	}
	buf := make([]byte, 2)
	if _, err := io.ReadFull(conn, buf); err != nil {
		return err
	}
	if buf[0] != 0x05 || buf[1] == 0xff {
		return fmt.Errorf("SOCKS5 authentication negotiation failed: %x", buf)
	}
	if buf[1] == 0x02 {
		if userInfo == nil || userInfo.Username() == "" {
			return fmt.Errorf("SOCKS5 proxy requires username/password")
		}
		username := []byte(userInfo.Username())
		passwordValue, _ := userInfo.Password()
		password := []byte(passwordValue)
		if len(username) > 255 || len(password) > 255 {
			return fmt.Errorf("SOCKS5 username/password is too long")
		}
		auth := append([]byte{0x01, byte(len(username))}, username...)
		auth = append(auth, byte(len(password)))
		auth = append(auth, password...)
		if _, err := conn.Write(auth); err != nil {
			return err
		}
		if _, err := io.ReadFull(conn, buf); err != nil {
			return err
		}
		if buf[1] != 0x00 {
			return fmt.Errorf("SOCKS5 username/password authentication failed")
		}
	} else if buf[1] != 0x00 {
		return fmt.Errorf("SOCKS5 unsupported authentication method: %d", buf[1])
	}
	hostBytes := []byte(targetHost)
	if len(hostBytes) > 255 {
		return fmt.Errorf("SOCKS5 target host too long")
	}
	req := []byte{0x05, 0x01, 0x00, 0x03, byte(len(hostBytes))}
	req = append(req, hostBytes...)
	var p [2]byte
	binary.BigEndian.PutUint16(p[:], uint16(targetPort))
	req = append(req, p[:]...)
	if _, err := conn.Write(req); err != nil {
		return err
	}
	head := make([]byte, 4)
	if _, err := io.ReadFull(conn, head); err != nil {
		return err
	}
	if head[0] != 5 || head[1] != 0 {
		return fmt.Errorf("SOCKS5 connect failed: %x", head)
	}
	switch head[3] {
	case 1:
		_, err := io.CopyN(io.Discard, conn, 6)
		return err
	case 3:
		ln := make([]byte, 1)
		if _, err := io.ReadFull(conn, ln); err != nil {
			return err
		}
		_, err := io.CopyN(io.Discard, conn, int64(ln[0])+2)
		return err
	case 4:
		_, err := io.CopyN(io.Discard, conn, 18)
		return err
	default:
		return fmt.Errorf("SOCKS5 unsupported bind address type: %d", head[3])
	}
}

func httpConnect(conn net.Conn, userInfo *url.Userinfo, targetHost string, targetPort int) error {
	target := net.JoinHostPort(targetHost, strconv.Itoa(targetPort))
	authHeader := ""
	if userInfo != nil && userInfo.Username() != "" {
		password, _ := userInfo.Password()
		token := base64.StdEncoding.EncodeToString([]byte(userInfo.Username() + ":" + password))
		authHeader = "Proxy-Authorization: Basic " + token + "\r\n"
	}
	req := fmt.Sprintf("CONNECT %s HTTP/1.1\r\nHost: %s\r\n%sProxy-Connection: Keep-Alive\r\nConnection: keep-alive\r\n\r\n", target, target, authHeader)
	if _, err := conn.Write([]byte(req)); err != nil {
		return err
	}
	br := bufio.NewReader(conn)
	line, err := br.ReadString('\n')
	if err != nil {
		return err
	}
	parts := strings.Fields(line)
	if len(parts) < 2 || !strings.HasPrefix(parts[1], "2") {
		return fmt.Errorf("HTTP CONNECT failed: %s", strings.TrimSpace(line))
	}
	for {
		l, err := br.ReadString('\n')
		if err != nil {
			return err
		}
		if l == "\r\n" || l == "\n" {
			break
		}
	}
	return nil
}

func TestTCPProxy(ctx context.Context, proxyValue, targetHost string, targetPort int, timeout time.Duration) error {
	conn, err := dialTCP(ctx, targetHost, targetPort, timeout, proxyValue, false)
	if err != nil {
		return err
	}
	return conn.Close()
}

func mustAtoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}
