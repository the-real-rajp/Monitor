SHELL := /bin/bash
GO ?= go
BIN := bin
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X github.com/the-real-rajp/monitor/internal/version.Version=$(VERSION)

.PHONY: all build build-server build-prober build-agent web test test-integration lint fmt generate \
        sqlc openapi-types check dev-server dev-web clean

all: lint test build

## Build everything with the web UI embedded into the server binary.
build: web build-server build-prober build-agent

build-server:
	$(GO) build -tags embedweb -ldflags '$(LDFLAGS)' -o $(BIN)/monitor-server ./cmd/server

build-prober:
	$(GO) build -ldflags '$(LDFLAGS)' -o $(BIN)/monitor-prober ./cmd/prober

build-agent:
	$(GO) build -ldflags '$(LDFLAGS)' -o $(BIN)/monitor-agent ./cmd/agent

## Build the React app into internal/webui/dist so it can be embedded.
web:
	cd web && npm ci --no-audit --no-fund && npm run build

## Unit tests only (no databases needed).
test:
	$(GO) test -race -count=1 ./...

## Unit + integration tests. Requires MONITOR_TEST_PG_URL and MONITOR_TEST_CH_URL.
test-integration:
	$(GO) test -race -count=1 -tags integration ./...

lint:
	golangci-lint run ./...
	cd web && npm run lint

fmt:
	gofmt -w $$(git ls-files '*.go' | grep -v '/sqlc/')
	cd web && npm run fmt

## Regenerate everything that is checked in: sqlc code and OpenAPI TypeScript types.
generate: sqlc openapi-types

sqlc:
	sqlc generate -f internal/store/pg/sqlc.yaml

openapi-types:
	cd web && npm run openapi

## Fails if generated files are stale. Used by CI.
check: generate
	git diff --exit-code -- internal/store/pg/sqlc web/src/api/schema.d.ts

dev-server:
	$(GO) run ./cmd/server serve

dev-web:
	cd web && npm run dev

clean:
	rm -rf $(BIN) internal/webui/dist web/dist
