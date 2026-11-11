//go:build integration

package dialcache_test

import (
	"context"
	"io"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	. "github.com/lan17/DialCache/go"
	"github.com/redis/go-redis/v9"
)

// faultProxy forwards TCP to Redis and can refuse connections ("down") or
// accept them and drop every byte ("hung").
type faultProxy struct {
	t       *testing.T
	target  string
	address string

	mu       sync.Mutex
	mode     string
	listener net.Listener
	conns    map[net.Conn]bool // value marks upstream connections
}

func startFaultProxy(t *testing.T, target string) *faultProxy {
	p := &faultProxy{t: t, target: target, mode: "pass", conns: make(map[net.Conn]bool)}
	p.listen("127.0.0.1:0")
	t.Cleanup(func() { p.set("down") })
	return p
}

func (p *faultProxy) listen(address string) {
	listener, err := net.Listen("tcp", address)
	if err != nil {
		p.t.Fatal(err)
	}
	p.listener, p.address = listener, listener.Addr().String()
	go func() {
		for {
			client, err := listener.Accept()
			if err != nil {
				return
			}
			go p.serve(client)
		}
	}()
}

func (p *faultProxy) track(conn net.Conn, upstream bool) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.mode == "down" {
		return false
	}
	p.conns[conn] = upstream
	return true
}

func (p *faultProxy) serve(client net.Conn) {
	defer client.Close()
	if !p.track(client, false) {
		return
	}
	p.mu.Lock()
	hung := p.mode == "hung"
	p.mu.Unlock()
	if !hung {
		upstream, err := net.Dial("tcp", p.target)
		if err != nil || !p.track(upstream, true) {
			return
		}
		go func() { _, _ = io.Copy(client, upstream) }()
		_, _ = io.Copy(upstream, client)
		upstream.Close()
	}
	// Hung: keep the client connected and drop its commands.
	_, _ = io.Copy(io.Discard, client)
}

func (p *faultProxy) set(mode string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if mode == p.mode {
		return
	}
	if p.mode == "down" {
		p.listen(p.address)
	}
	p.mode = mode
	for conn, upstream := range p.conns {
		// Down closes everything; hung cuts Redis off from open connections.
		if mode == "down" || (mode == "hung" && upstream) {
			conn.Close()
			delete(p.conns, conn)
		}
	}
	if mode == "down" {
		p.listener.Close()
	}
}

// countingRemote counts the reads that pass the breaker.
type countingRemote struct {
	Remote
	reads atomic.Int64
}

func (r *countingRemote) Read(ctx context.Context, valueKey, watermarkKey string) (ReadResult, error) {
	r.reads.Add(1)
	return r.Remote.Read(ctx, valueKey, watermarkKey)
}

type silentLogger struct{}

func (silentLogger) Debug(string, any) {}
func (silentLogger) Warn(string, any)  {}
func (silentLogger) Error(string, any) {}

// A real Redis that refuses connections or stops answering opens the read
// circuit; calls then reach the source without touching Redis, and the circuit
// closes again after Redis returns.
func testCircuitBreaker(t *testing.T, environment redisEnvironment) {
	proxy := startFaultProxy(t, environment.endpoint)
	client := redis.NewClient(&redis.Options{Addr: proxy.address, DialTimeout: 200 * time.Millisecond, ReadTimeout: 200 * time.Millisecond, WriteTimeout: 200 * time.Millisecond, MaxRetries: -1, DialerRetries: 1})
	t.Cleanup(func() { _ = client.Close() })
	transitions := make(chan string, 64)
	adapter := &countingRemote{Remote: NewRedisAdapter(client)}
	breaker, err := NewCircuitBreaker(adapter, CircuitBreakerOptions{
		OpenFor: 500 * time.Millisecond,
		OnStateChange: func(operation string, _, to CircuitState) {
			transitions <- operation + " " + to.String()
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	cache := MustNew(WithRemote(breaker), WithLocalCapacity(0), WithLogger(silentLogger{}), WithNamespace("breaker-"+strconv.FormatInt(time.Now().UnixNano(), 36)))
	var sources atomic.Int64
	load := func(id string) time.Duration {
		ctx, done := cache.Enable(context.Background())
		defer done()
		start := time.Now()
		value, err := GetOrLoad(ctx, cache, Operation[string]{
			Identity: Identity{KeyType: "user", UseCase: "breaker", ID: id},
			Policy:   Policy{RemoteTTL: time.Minute},
		}, func(context.Context) (string, error) {
			sources.Add(1)
			return "source " + id, nil
		})
		if err != nil || value != "source "+id {
			t.Fatalf("GetOrLoad(%s) = %q, %v", id, value, err)
		}
		return time.Since(start)
	}
	await := func(want string) {
		t.Helper()
		deadline := time.After(10 * time.Second)
		for {
			select {
			case got := <-transitions:
				if got == want {
					return
				}
			case <-deadline:
				t.Fatalf("no %q transition", want)
			}
		}
	}
	servedFromRedis := func(id string) {
		t.Helper()
		before := sources.Load()
		load(id)
		load(id)
		if sources.Load() != before+1 {
			t.Fatalf("%s: the second call did not hit Redis", id)
		}
	}

	servedFromRedis("healthy")
	for _, fault := range []string{"down", "hung"} {
		proxy.set(fault)
		var wg sync.WaitGroup
		for i := range 100 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				load(fault + "-" + strconv.Itoa(i))
			}()
		}
		wg.Wait()
		await("read open")

		reads := adapter.reads.Load()
		for i := range 20 {
			if took := load(fault + "-open-" + strconv.Itoa(i)); took > 25*time.Millisecond {
				t.Fatalf("%s: a call with an open circuit took %v", fault, took)
			}
		}
		if adapter.reads.Load() != reads {
			t.Fatalf("%s: reads reached Redis while the circuit was open", fault)
		}

		proxy.set("pass")
		closed := make(chan struct{})
		go func() {
			await("read closed")
			close(closed)
		}()
	probe:
		for i := 0; ; i++ {
			select {
			case <-closed:
				break probe
			case <-time.After(50 * time.Millisecond):
				load(fault + "-probe-" + strconv.Itoa(i))
			}
		}
		servedFromRedis("after-" + fault)
	}
}
