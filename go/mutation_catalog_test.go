package dialcache

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The Go mutation catalog anchors textual edits in production sources. A
// rename can leave an anchor unmatched or a replacement uncompilable, which
// the full mutation lane reports as a measurement error rather than a
// detection result. This guard catches both at PR time: every edit must match
// exactly once and every mutant must still build.
func TestMutationCatalogMutantsCompile(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "formal", "go-mutations.json"))
	if errors.Is(err, fs.ErrNotExist) {
		t.Skip("the mutation catalog is not part of the module")
	}
	if err != nil {
		t.Fatal(err)
	}
	var catalog struct {
		Mutations []struct {
			ID    string
			Edits []struct{ Path, Before, After string }
		}
	}
	if err := json.Unmarshal(raw, &catalog); err != nil {
		t.Fatal(err)
	}
	sources, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	var production []string
	for _, source := range sources {
		if !strings.HasSuffix(source, "_test.go") {
			production = append(production, source)
		}
	}
	production = append(production, "go.mod", "go.sum")
	goBinary := filepath.Join(runtime.GOROOT(), "bin", "go")
	if _, err := os.Stat(goBinary); err != nil {
		if goBinary, err = exec.LookPath("go"); err != nil {
			t.Skip("no go toolchain to compile mutants with")
		}
	}
	for _, mutation := range catalog.Mutations {
		t.Run(mutation.ID, func(t *testing.T) {
			t.Parallel()
			dir := t.TempDir()
			for _, name := range production {
				content, err := os.ReadFile(name)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dir, name), content, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			for _, edit := range mutation.Edits {
				name := strings.TrimPrefix(edit.Path, "go/")
				target := filepath.Join(dir, name)
				content, err := os.ReadFile(target)
				if err != nil {
					t.Fatalf("edit path %s: %v", edit.Path, err)
				}
				if n := strings.Count(string(content), edit.Before); n != 1 {
					t.Fatalf("anchor in %s occurs %d times, want exactly once: %q", edit.Path, n, edit.Before)
				}
				if err := os.WriteFile(target, []byte(strings.Replace(string(content), edit.Before, edit.After, 1)), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			build := exec.Command(goBinary, "build", "./...")
			build.Dir = dir
			build.Env = append(os.Environ(), "GOWORK=off", "GOFLAGS=-mod=mod")
			if output, err := build.CombinedOutput(); err != nil {
				t.Fatalf("mutant does not compile: %v\n%s", err, output)
			}
		})
	}
}
