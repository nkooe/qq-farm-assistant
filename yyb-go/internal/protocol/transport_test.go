package protocol

import (
	"bufio"
	"context"
	"encoding/base64"
	"io"
	"net"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestSOCKS5UsernamePasswordAuthentication(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	done := make(chan error, 1)
	go func() {
		methods := make([]byte, 4)
		if _, err := io.ReadFull(server, methods); err != nil {
			done <- err
			return
		}
		if string(methods) != string([]byte{5, 2, 0, 2}) {
			done <- &testError{"unexpected methods"}
			return
		}
		_, _ = server.Write([]byte{5, 2})
		authHead := make([]byte, 2)
		_, _ = io.ReadFull(server, authHead)
		username := make([]byte, int(authHead[1]))
		_, _ = io.ReadFull(server, username)
		passwordLen := make([]byte, 1)
		_, _ = io.ReadFull(server, passwordLen)
		password := make([]byte, int(passwordLen[0]))
		_, _ = io.ReadFull(server, password)
		if string(username) != "alice" || string(password) != "secret" {
			done <- &testError{"unexpected credentials"}
			return
		}
		_, _ = server.Write([]byte{1, 0})
		reqHead := make([]byte, 5)
		_, _ = io.ReadFull(server, reqHead)
		host := make([]byte, int(reqHead[4]))
		_, _ = io.ReadFull(server, host)
		port := make([]byte, 2)
		_, _ = io.ReadFull(server, port)
		_, _ = server.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 80})
		done <- nil
	}()
	if err := socks5Connect(client, url.UserPassword("alice", "secret"), "example.com", 443); err != nil {
		t.Fatalf("socks5Connect() error = %v", err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestHTTPConnectBasicAuthentication(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	done := make(chan error, 1)
	go func() {
		reader := bufio.NewReader(server)
		request, err := reader.ReadString('\n')
		if err != nil || !strings.Contains(request, "CONNECT example.com:443") {
			done <- &testError{"unexpected CONNECT line"}
			return
		}
		found := false
		for {
			line, readErr := reader.ReadString('\n')
			if readErr != nil {
				done <- readErr
				return
			}
			if strings.HasPrefix(strings.ToLower(line), "proxy-authorization:") {
				found = strings.Contains(line, base64.StdEncoding.EncodeToString([]byte("alice:secret")))
			}
			if line == "\r\n" {
				break
			}
		}
		if !found {
			done <- &testError{"missing basic proxy auth"}
			return
		}
		_, _ = server.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
		done <- nil
	}()
	if err := httpConnect(client, url.UserPassword("alice", "secret"), "example.com", 443); err != nil {
		t.Fatalf("httpConnect() error = %v", err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestProxyHandshakeStopsWhenContextIsCancelled(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		conn, acceptErr := listener.Accept()
		if acceptErr == nil {
			defer conn.Close()
			_, _ = io.Copy(io.Discard, conn)
		}
	}()

	host, portText, _ := net.SplitHostPort(listener.Addr().String())
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	started := time.Now()
	_, err = dialViaProxy(ctx, &tcpProxy{Scheme: "socks5", Host: host, Port: portText}, "example.com", 443, 5*time.Second)
	if err == nil {
		t.Fatal("dialViaProxy() unexpectedly succeeded")
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("cancelled proxy handshake took %s", elapsed)
	}
	select {
	case <-serverDone:
	case <-time.After(time.Second):
		t.Fatal("proxy test server did not observe the cancelled connection")
	}
}

type testError struct{ message string }

func (e *testError) Error() string { return e.message }
