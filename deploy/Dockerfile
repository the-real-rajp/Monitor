# Builds monitor-server with the web UI embedded. Build from the repo root:
#   docker build -f deploy/Dockerfile -t monitor-server .

FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
COPY api/ ../api/
RUN npm run build

FROM golang:1.24-alpine AS build
ARG VERSION=dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/internal/webui/dist ./internal/webui/dist
RUN CGO_ENABLED=0 go build -tags embedweb -trimpath \
      -ldflags "-s -w -X github.com/the-real-rajp/monitor/internal/version.Version=${VERSION}" \
      -o /out/monitor-server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/monitor-server /monitor-server
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/monitor-server"]
CMD ["serve"]
