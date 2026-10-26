// Package version holds build-time version information injected via ldflags.
package version

// Version is the build version. Overridden at build time with
// -ldflags "-X github.com/the-real-rajp/monitor/internal/version.Version=v1.2.3".
var Version = "dev"
