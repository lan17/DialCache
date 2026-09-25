// Package logging supplies the default cache logger.
package logging

import "log"

// The default follows the TypeScript console logger. Applications may provide
// their own Logger; all its callbacks are isolated from cache/source results.
type Logger struct{}

func (Logger) Debug(message string, details any) { log.Print(message, ": ", details) }
func (Logger) Warn(message string, details any)  { log.Print(message, ": ", details) }
func (Logger) Error(message string, details any) { log.Print(message, ": ", details) }
