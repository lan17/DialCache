package dialcache_test

import (
	"context"
	"fmt"

	dialcache "github.com/lan17/DialCache/go"
)

func ExampleCached() {
	cache, err := dialcache.New()
	if err != nil {
		panic(err)
	}
	loads := 0
	lookup, err := dialcache.Cached(cache, dialcache.Operation[string]{
		Identity: dialcache.Identity{KeyType: "user", UseCase: "displayName"},
		Policy:   dialcache.Policy{RequestLocal: true},
	}, func(id string) (dialcache.Identity, error) {
		return dialcache.Identity{ID: id}, nil
	}, func(ctx context.Context, id string) (string, error) {
		loads++
		return "Ada", nil
	})
	if err != nil {
		panic(err)
	}
	// Caching is off until a request scope is enabled; done closes the scope.
	ctx, done := cache.Enable(context.Background())
	defer done()
	for range 2 {
		value, err := lookup(ctx, "42")
		if err != nil {
			panic(err)
		}
		fmt.Println(value)
	}
	fmt.Println("source calls:", loads)
	// Output:
	// Ada
	// Ada
	// source calls: 1
}
