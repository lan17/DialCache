// Package logging supplies the default cache logger.
package logging

import (
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
	log.Print(escapeControls(fmt.Sprint(message, ": ", details)))
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
