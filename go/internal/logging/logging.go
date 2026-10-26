// Package logging supplies the default cache logger.
package logging

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"strings"
	"unicode/utf8"
)

// The default follows the TypeScript console logger. Applications may provide
// their own Logger; all its callbacks are isolated from cache/source results.
type Logger struct{}

func (Logger) Debug(message string, details any) { write(message, details) }
func (Logger) Warn(message string, details any)  { write(message, details) }
func (Logger) Error(message string, details any) { write(message, details) }

// write logs one line. Details can carry application text, such as the member
// names in a mismatch warning's pointers, so the whole line is escaped: a
// newline cannot forge another line and an escape sequence cannot reach the
// terminal.
func write(message string, details any) {
	log.Print(escapeControls(message + ": " + renderDetails(details)))
}

// renderDetails writes a structured details map, such as the mismatch
// warning's, as JSON, so each string keeps its bounds: a root pointer "" prints
// as [""] where an empty list prints as [], and a pointer holding a space stays
// one element. Every escape is a JSON escape, so the text still parses after
// escapeControls: encoding/json escapes C0 controls, U+2028 and U+2029 and
// replaces bytes that are not UTF-8 with U+FFFD, DEL is written as \u007f here,
// and escapeControls writes C1 controls as \u0080 to \u009f. An error, or any
// other details value, prints as fmt.Sprint does; a map[string]any has no
// methods, so it is never an error.
func renderDetails(details any) string {
	fields, ok := details.(map[string]any)
	if !ok {
		return fmt.Sprint(details)
	}
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(fields); err != nil {
		return fmt.Sprint(details)
	}
	return strings.ReplaceAll(strings.TrimSuffix(encoded.String(), "\n"), "\x7f", `\u007f`)
}

// escapeControls writes each C0 and C1 control character, DEL, U+2028, U+2029
// and each byte that is not valid UTF-8 as its Go escape sequence, such as \n,
// \x1b, \u0085 or \u2028, and leaves every other character as written.
func escapeControls(text string) string {
	var escaped strings.Builder
	start := 0
	for index := 0; index < len(text); {
		r, size := utf8.DecodeRuneInString(text[index:])
		if (r != utf8.RuneError || size != 1) && !isControl(r) {
			index += size
			continue
		}
		quoted := strconv.Quote(text[index : index+size])
		escaped.WriteString(text[start:index])
		escaped.WriteString(quoted[1 : len(quoted)-1])
		index += size
		start = index
	}
	if start == 0 {
		return text
	}
	escaped.WriteString(text[start:])
	return escaped.String()
}

func isControl(r rune) bool {
	return r < 0x20 || r >= 0x7f && r <= 0x9f || r == '\u2028' || r == '\u2029'
}
