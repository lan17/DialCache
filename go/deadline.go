package dialcache

import (
	"sync"
	"time"
)

type completion[T any] struct {
	value T
	err   error
}
type pending[T any] struct {
	done   chan struct{}
	result completion[T]
}

func callSafely[T any](f func() (T, error)) (value T, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = &CallbackPanicError{Value: p}
		}
	}()
	return f()
}

func startPending[T any](f func() (T, error)) *pending[T] {
	p := &pending[T]{done: make(chan struct{})}
	go func() { p.result.value, p.result.err = callSafely(f); close(p.done) }()
	return p
}

func after(clock Clock, ms int64, f func()) Timer {
	if ms < 0 {
		ms = 0
	}
	if timers, ok := clock.(TimerClock); ok {
		return timers.AfterFunc(ms, f)
	}
	return time.AfterFunc(time.Duration(ms)*time.Millisecond, f)
}

// awaitDeadline accepts only results observed strictly before the deadline.
// Raw work keeps ownership of its resources after the caller stops waiting.
func awaitDeadline[T any](clock Clock, p *pending[T], started, budget int64, timeout func() error, onTimeout func()) (T, error) {
	if budget < 0 {
		<-p.done
		return p.result.value, p.result.err
	}
	var once sync.Once
	expired := make(chan struct{})
	timer := after(clock, budget-(clock.ElapsedMS()-started), func() { once.Do(func() { close(expired) }) })
	defer timer.Stop()
	select {
	case <-p.done:
		if clock.ElapsedMS()-started < budget {
			return p.result.value, p.result.err
		}
	case <-expired:
	}
	if onTimeout != nil {
		onTimeout()
	}
	var zero T
	return zero, timeout()
}

func deferWork(clock Clock, f func()) {
	if executor, ok := clock.(DeferredExecutor); ok {
		executor.Defer(f)
		return
	}
	go f()
}
