package main

import "time"

// Endpoint represents a webhook endpoint that can receive requests.
type Endpoint struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
	RequestCount int    `json:"request_count"`
}

// WebhookRequest represents a captured incoming webhook request.
type WebhookRequest struct {
	ID          string            `json:"id"`
	EndpointID  string            `json:"endpoint_id"`
	Method      string            `json:"method"`
	Headers     map[string]string `json:"headers"`
	Body        string            `json:"body"`
	QueryParams map[string]string `json:"query_params"`
	SourceIP    string            `json:"source_ip"`
	ContentType string            `json:"content_type"`
	ReceivedAt  time.Time         `json:"received_at"`
	Size        int               `json:"size"`
}

// ReplayRequest is the payload for replaying a webhook to a target URL.
type ReplayRequest struct {
	TargetURL string `json:"target_url"`
}

// ReplayResponse is returned after attempting to replay a webhook.
type ReplayResponse struct {
	StatusCode int               `json:"status_code"`
	Headers    map[string]string `json:"headers"`
	Body       string            `json:"body"`
	Duration   string            `json:"duration"`
}

// StatsResponse contains system-level statistics.
type StatsResponse struct {
	Uptime           string `json:"uptime"`
	WebhooksReceived int    `json:"webhooks_received"`
	EndpointCount    int    `json:"endpoint_count"`
	WSConnections    int    `json:"ws_connections"`
	MemoryMB         string `json:"memory_mb"`
	GoVersion        string `json:"go_version"`
}

// HealthResponse is returned by the health check endpoint.
type HealthResponse struct {
	Status           string `json:"status"`
	Uptime           string `json:"uptime"`
	WebhooksReceived int    `json:"webhooks_received"`
}

// WSMessage is a WebSocket message sent to connected clients.
type WSMessage struct {
	Type    string      `json:"type"`
	Payload interface{} `json:"payload"`
}
