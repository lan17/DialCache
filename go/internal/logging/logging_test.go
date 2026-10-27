package logging

import (
	"bytes"
	"encoding/json"
	"errors"
	"log"
	"reflect"
	"strings"
	"testing"
)

// capture returns what the default logger writes while run executes.
func capture(t *testing.T, run func()) string {
	t.Helper()
	var output bytes.Buffer
	writer, flags := log.Writer(), log.Flags()
	log.SetOutput(&output)
	log.SetFlags(0)
	t.Cleanup(func() { log.SetOutput(writer); log.SetFlags(flags) })
	run()
	return output.String()
}

func TestDefaultLoggerKeepsAWarningOnOneLine(t *testing.T) {
	// A member name reaches the warning's pointers as written.
	details := map[string]any{"mismatchPaths": []string{"/user\nDialCache forged: line\x1b[2J"}, "mismatchPathCount": 1}
	for name, write := range map[string]func(string, any){"Debug": Logger{}.Debug, "Warn": Logger{}.Warn, "Error": Logger{}.Error} {
		t.Run(name, func(t *testing.T) {
			output := capture(t, func() { write("DialCache shadow validation mismatch", details) })
			want := `DialCache shadow validation mismatch: {"mismatchPathCount":1,"mismatchPaths":["/user\nDialCache forged: line\u001b[2J"]}` + "\n"
			if output != want {
				t.Fatalf("logged %q, want %q", output, want)
			}
		})
	}
}

func TestDefaultLoggerWritesDetailsAsJSON(t *testing.T) {
	for _, test := range []struct {
		name    string
		details any
		want    string
	}{
		{"a root pointer", map[string]any{"mismatchPaths": []string{""}}, `{"mismatchPaths":[""]}`},
		{"no pointers", map[string]any{"mismatchPaths": []string{}}, `{"mismatchPaths":[]}`},
		{"a pointer holding a space", map[string]any{"mismatchPaths": []string{"/a b"}}, `{"mismatchPaths":["/a b"]}`},
		{"two pointers", map[string]any{"mismatchPaths": []string{"/a", "b"}}, `{"mismatchPaths":["/a","b"]}`},
		{"null and text fields", map[string]any{"diffJson": nil, "cachedValueJson": `{"a":"<&>"}`, "cachedValueAgeSeconds": 30.5},
			`{"cachedValueAgeSeconds":30.5,"cachedValueJson":"{\"a\":\"<&>\"}","diffJson":null}`},
		{"an error", errors.New("redis: connection refused"), "redis: connection refused"},
	} {
		t.Run(test.name, func(t *testing.T) {
			output := capture(t, func() { Logger{}.Warn("message", test.details) })
			if want := "message: " + test.want + "\n"; output != want {
				t.Fatalf("logged %q, want %q", output, want)
			}
		})
	}
}

func TestDefaultLoggerDetailsParseBack(t *testing.T) {
	// encoding/json leaves DEL and C1 controls raw; both must still leave the
	// line one line whose details parse as JSON.
	name := "/a\x7fb\u0085c\u2028d\ne\x1bf\u009fg"
	details := map[string]any{"mismatchPaths": []string{name, "/h\xffi"}}
	output := capture(t, func() { Logger{}.Warn("message", details) })
	text, found := strings.CutPrefix(strings.TrimSuffix(output, "\n"), "message: ")
	if !found || strings.ContainsAny(text, "\n\r\x1b\x7f\u0085\u009f\u2028") {
		t.Fatalf("logged %q", output)
	}
	var parsed map[string][]string
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		t.Fatalf("details %q do not parse: %v", text, err)
	}
	if want := []string{name, "/h\ufffdi"}; !reflect.DeepEqual(parsed["mismatchPaths"], want) {
		t.Fatalf("parsed %q, want %q", parsed["mismatchPaths"], want)
	}
}

func TestEscapeControls(t *testing.T) {
	for _, test := range []struct{ name, text, want string }{
		{"readable text unchanged", `id "é" ~/a\b 💡`, `id "é" ~/a\b 💡`},
		{"C0 controls", "a\x00b\tc\rd\ne\x1bf\x1f", `a\x00b\tc\rd\ne\x1bf\x1f`},
		{"DEL", "a\x7fb", `a\x7fb`},
		{"C1 controls", "a\u0080b\u0085c\u009bd\u009f", `a\u0080b\u0085c\u009bd\u009f`},
		{"line and paragraph separators", "a\u2028b\u2029c", `a\u2028b\u2029c`},
		{"bytes that are not UTF-8", "a\x9bb\xffc\xe2\x80", `a\x9bb\xffc\xe2\x80`},
		{"replacement character kept", "a\ufffdb", "a\ufffdb"},
		{"leading and trailing controls", "\nab\n", `\nab\n`},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := escapeControls(test.text); got != test.want {
				t.Fatalf("escaped %q as %q, want %q", test.text, got, test.want)
			}
			if got := escapeControls(test.text); strings.ContainsAny(got, "\n\r\x1b\u2028\u2029\u0085") {
				t.Fatalf("escaped text %q keeps a control character", got)
			}
		})
	}
}
