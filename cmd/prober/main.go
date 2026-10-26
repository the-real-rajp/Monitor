// Command monitor-prober is a placeholder for the prober binary that arrives in a
// later phase. It exists so the build, lint and release pipeline cover all
// three binaries from the start.
package main

import (
	"fmt"
	"os"

	"github.com/the-real-rajp/monitor/internal/version"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "version" {
		fmt.Println(version.Version)
		return
	}
	fmt.Fprintln(os.Stderr, "monitor-prober is not implemented yet; see docs/PLAN.md for the phase that delivers it")
	os.Exit(2)
}
