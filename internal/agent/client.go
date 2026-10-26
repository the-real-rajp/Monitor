package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Device is one target the website wants this proxy to ping.
type Device struct {
	ID       int    `json:"id"`
	Host     string `json:"host"`
	Interval int    `json:"interval_s"`
}

// Result is one ping outcome. RTT is nil on timeout.
type Result struct {
	DeviceID int      `json:"device_id"`
	TS       int64    `json:"ts"` // unix seconds
	RTT      *float64 `json:"rtt_ms"`
}

// ResultsResponse is what the website reports back for a batch.
type ResultsResponse struct {
	Accepted int `json:"accepted"`
	Stored   int `json:"stored"`
	Rejected int `json:"rejected"`
}

// Client talks to the website's agent API.
type Client struct {
	base    string
	key     string
	version string
	http    *http.Client
}

// NewClient returns a client with sensible timeouts.
func NewClient(baseURL, key, version string) *Client {
	return &Client{
		base:    baseURL,
		key:     key,
		version: version,
		http: &http.Client{
			Timeout: 30 * time.Second,
			Transport: &http.Transport{
				MaxIdleConns:        2,
				IdleConnTimeout:     90 * time.Second,
				TLSHandshakeTimeout: 10 * time.Second,
				Proxy:               http.ProxyFromEnvironment,
			},
		},
	}
}

// APIError is a non-2xx response from the website.
type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("website returned %d %s: %s", e.Status, e.Code, e.Message)
}

// Permanent reports whether retrying the same request cannot help (bad key,
// malformed batch). The caller logs loudly rather than retrying forever.
func (e *APIError) Permanent() bool {
	return e.Status == 401 || e.Status == 403 || e.Status == 400
}

// Devices fetches the device list. It passes etag as If-None-Match; when the
// list is unchanged it returns changed=false and the same etag.
func (c *Client) Devices(ctx context.Context, etag string) (devices []Device, newEtag string, changed bool, err error) {
	req, err := c.newRequest(ctx, http.MethodGet, "/api/agent/devices", nil)
	if err != nil {
		return nil, etag, false, err
	}
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, etag, false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotModified {
		return nil, etag, false, nil
	}
	if err := checkStatus(resp); err != nil {
		return nil, etag, false, err
	}
	var body struct {
		Devices []Device `json:"devices"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&body); err != nil {
		return nil, etag, false, fmt.Errorf("decode devices: %w", err)
	}
	return body.Devices, resp.Header.Get("ETag"), true, nil
}

// PostResults uploads a batch.
func (c *Client) PostResults(ctx context.Context, results []Result, queueDepth int) (ResultsResponse, error) {
	var out ResultsResponse
	payload := struct {
		Results    []Result `json:"results"`
		QueueDepth int      `json:"queue_depth"`
	}{results, queueDepth}
	if err := c.postJSON(ctx, "/api/agent/results", payload, &out); err != nil {
		return out, err
	}
	return out, nil
}

// Heartbeat tells the website the proxy is alive.
func (c *Client) Heartbeat(ctx context.Context, uptime time.Duration, queueDepth int) error {
	payload := struct {
		Version    string `json:"version"`
		UptimeS    int64  `json:"uptime_s"`
		QueueDepth int    `json:"queue_depth"`
	}{c.version, int64(uptime.Seconds()), queueDepth}
	return c.postJSON(ctx, "/api/agent/heartbeat", payload, nil)
}

func (c *Client) postJSON(ctx context.Context, path string, payload any, out any) error {
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := c.newRequest(ctx, http.MethodPost, path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if err := checkStatus(resp); err != nil {
		return err
	}
	if out != nil {
		if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out); err != nil {
			return fmt.Errorf("decode %s: %w", path, err)
		}
	}
	return nil
}

func (c *Client) newRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.key)
	req.Header.Set("User-Agent", "monitor-agent/"+c.version)
	req.Header.Set("Accept", "application/json")
	return req, nil
}

func checkStatus(resp *http.Response) error {
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	apiErr := &APIError{Status: resp.StatusCode, Code: "unknown", Message: resp.Status}
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&body); err == nil && body.Error.Code != "" {
		apiErr.Code = body.Error.Code
		apiErr.Message = body.Error.Message
	}
	return apiErr
}

// IsPermanent reports whether err is an APIError that retrying cannot fix.
func IsPermanent(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.Permanent()
}
