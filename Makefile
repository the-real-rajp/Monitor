SHELL := /bin/bash
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.Version=$(VERSION)

.PHONY: all agent agent-release ui web-test agent-test test lint dev-web dev-ui dev-agent clean

all: lint test agent ui

## The proxy binary for this machine.
agent:
	go build -trimpath -ldflags '$(LDFLAGS)' -o bin/monitor-agent ./cmd/agent

## Cross-compiled proxy binaries for a release.
agent-release:
	GOOS=linux GOARCH=amd64 go build -trimpath -ldflags '$(LDFLAGS)' -o bin/monitor-agent-linux-amd64 ./cmd/agent
	GOOS=linux GOARCH=arm64 go build -trimpath -ldflags '$(LDFLAGS)' -o bin/monitor-agent-linux-arm64 ./cmd/agent
	GOOS=linux GOARCH=arm GOARM=6 go build -trimpath -ldflags '$(LDFLAGS)' -o bin/monitor-agent-linux-arm ./cmd/agent

## Build the dashboard into web/public (index.html + assets/).
ui:
	cd ui && npm ci --no-audit --no-fund && npm run build

agent-test:
	go vet ./... && go test -race -count=1 ./...

## PHP tests need a MySQL/MariaDB reachable via MONITOR_TEST_* (see web/phpunit.xml).
web-test:
	cd web && composer install --quiet && composer lint && vendor/bin/phpunit

test: agent-test web-test

lint:
	gofmt -l . | grep -v '^$$' && exit 1 || true
	go vet ./...
	cd web && composer lint
	cd ui && npm run lint

## Local development: PHP built-in server on :8000 (config: web/config.php).
dev-web:
	cd web && php -S 127.0.0.1:8000 -t public public/index.php

dev-ui:
	cd ui && npm run dev

dev-agent:
	go run ./cmd/agent -config ./agent.env

clean:
	rm -rf bin web/public/assets web/public/index.html ui/dist
