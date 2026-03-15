package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"runtime"
	"strings"
	"time"
)

// Server holds shared state for all HTTP handlers.
type Server struct {
	db        *DB
	hub       *Hub
	startTime time.Time
}

// NewServer creates a new Server instance.
func NewServer(db *DB, hub *Hub) *Server {
	return &Server{
		db:        db,
		hub:       hub,
		startTime: time.Now(),
	}
}

// --- Health ---

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	resp := HealthResponse{
		Status:           "ok",
		Uptime:           formatDuration(time.Since(s.startTime)),
		WebhooksReceived: s.db.TotalRequests(),
	}
	writeJSON(w, http.StatusOK, resp)
}

// --- Stats ---

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)

	resp := StatsResponse{
		Uptime:           formatDuration(time.Since(s.startTime)),
		WebhooksReceived: s.db.TotalRequests(),
		EndpointCount:    s.db.EndpointCount(),
		WSConnections:    s.hub.ConnectionCount(),
		MemoryMB:         fmt.Sprintf("%.1f", float64(m.Alloc)/(1024*1024)),
		GoVersion:        runtime.Version(),
	}
	writeJSON(w, http.StatusOK, resp)
}

// --- Endpoints ---

func (s *Server) handleListEndpoints(w http.ResponseWriter, r *http.Request) {
	endpoints, err := s.db.ListEndpoints()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list endpoints")
		log.Printf("list endpoints error: %v", err)
		return
	}
	if endpoints == nil {
		endpoints = []Endpoint{}
	}
	writeJSON(w, http.StatusOK, endpoints)
}

func (s *Server) handleCreateEndpoint(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if r.Body != nil {
		json.NewDecoder(r.Body).Decode(&body)
	}

	id := generateID(8)
	if body.Name == "" {
		body.Name = "Endpoint " + id[:4]
	}

	ep, err := s.db.CreateEndpoint(id, body.Name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create endpoint")
		log.Printf("create endpoint error: %v", err)
		return
	}

	s.hub.Broadcast(WSMessage{Type: "endpoint_created", Payload: ep})
	writeJSON(w, http.StatusCreated, ep)
}

func (s *Server) handleGetEndpoint(w http.ResponseWriter, r *http.Request) {
	id := extractPathParam(r.URL.Path, "/api/endpoints/")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing endpoint id")
		return
	}

	// Strip any trailing path segments (e.g. /requests)
	if idx := strings.Index(id, "/"); idx != -1 {
		id = id[:idx]
	}

	ep, err := s.db.GetEndpoint(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		log.Printf("get endpoint error: %v", err)
		return
	}
	if ep == nil {
		writeError(w, http.StatusNotFound, "endpoint not found")
		return
	}
	writeJSON(w, http.StatusOK, ep)
}

func (s *Server) handleDeleteEndpoint(w http.ResponseWriter, r *http.Request) {
	id := extractPathParam(r.URL.Path, "/api/endpoints/")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing endpoint id")
		return
	}

	if err := s.db.DeleteEndpoint(id); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete endpoint")
		log.Printf("delete endpoint error: %v", err)
		return
	}

	s.hub.Broadcast(WSMessage{Type: "endpoint_deleted", Payload: map[string]string{"id": id}})
	w.WriteHeader(http.StatusNoContent)
}

// --- Requests ---

func (s *Server) handleListRequests(w http.ResponseWriter, r *http.Request) {
	// Path: /api/endpoints/{id}/requests
	path := strings.TrimPrefix(r.URL.Path, "/api/endpoints/")
	parts := strings.SplitN(path, "/", 2)
	if len(parts) < 1 || parts[0] == "" {
		writeError(w, http.StatusBadRequest, "missing endpoint id")
		return
	}
	endpointID := parts[0]

	requests, err := s.db.ListRequests(endpointID, 100)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list requests")
		log.Printf("list requests error: %v", err)
		return
	}
	if requests == nil {
		requests = []WebhookRequest{}
	}
	writeJSON(w, http.StatusOK, requests)
}

// --- Webhook Catch-All ---

func (s *Server) handleWebhook(w http.ResponseWriter, r *http.Request) {
	id := extractPathParam(r.URL.Path, "/hook/")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing endpoint id")
		return
	}

	// Strip any trailing path after the endpoint ID
	if idx := strings.Index(id, "/"); idx != -1 {
		id = id[:idx]
	}

	// Verify endpoint exists
	ep, err := s.db.GetEndpoint(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		log.Printf("webhook lookup error: %v", err)
		return
	}
	if ep == nil {
		writeError(w, http.StatusNotFound, "endpoint not found")
		return
	}

	// Read body
	bodyBytes, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1 MB limit
	if err != nil {
		writeError(w, http.StatusBadRequest, "failed to read body")
		return
	}

	// Collect headers
	headers := make(map[string]string)
	for k, v := range r.Header {
		headers[k] = strings.Join(v, ", ")
	}

	// Collect query params
	queryParams := make(map[string]string)
	for k, v := range r.URL.Query() {
		queryParams[k] = strings.Join(v, ", ")
	}

	sourceIP := r.RemoteAddr
	if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
		sourceIP = strings.Split(fwd, ",")[0]
	}

	req := &WebhookRequest{
		ID:          generateID(12),
		EndpointID:  id,
		Method:      r.Method,
		Headers:     headers,
		Body:        string(bodyBytes),
		QueryParams: queryParams,
		SourceIP:    strings.TrimSpace(sourceIP),
		ContentType: r.Header.Get("Content-Type"),
		ReceivedAt:  time.Now().UTC(),
		Size:        len(bodyBytes),
	}

	if err := s.db.SaveRequest(req); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save request")
		log.Printf("save request error: %v", err)
		return
	}

	log.Printf("webhook received: %s %s endpoint=%s size=%d", req.Method, r.URL.Path, id, req.Size)

	s.hub.Broadcast(WSMessage{Type: "webhook_received", Payload: req})

	writeJSON(w, http.StatusOK, map[string]string{
		"status":     "received",
		"request_id": req.ID,
	})
}

// --- Replay ---

func (s *Server) handleReplay(w http.ResponseWriter, r *http.Request) {
	// Path: /api/requests/{id}/replay
	path := strings.TrimPrefix(r.URL.Path, "/api/requests/")
	parts := strings.SplitN(path, "/", 2)
	if len(parts) < 1 || parts[0] == "" {
		writeError(w, http.StatusBadRequest, "missing request id")
		return
	}
	requestID := parts[0]

	var replay ReplayRequest
	if err := json.NewDecoder(r.Body).Decode(&replay); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if replay.TargetURL == "" {
		writeError(w, http.StatusBadRequest, "target_url is required")
		return
	}

	// Look up original request
	orig, err := s.db.GetRequest(requestID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database error")
		log.Printf("replay lookup error: %v", err)
		return
	}
	if orig == nil {
		writeError(w, http.StatusNotFound, "request not found")
		return
	}

	// Forward the request
	client := &http.Client{Timeout: 30 * time.Second}
	start := time.Now()

	httpReq, err := http.NewRequest(orig.Method, replay.TargetURL, bytes.NewReader([]byte(orig.Body)))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid target URL")
		return
	}

	if orig.ContentType != "" {
		httpReq.Header.Set("Content-Type", orig.ContentType)
	}
	httpReq.Header.Set("X-Webhook-Relay", "replayed")
	httpReq.Header.Set("X-Original-Request-ID", orig.ID)

	resp, err := client.Do(httpReq)
	if err != nil {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("replay failed: %v", err))
		return
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	respHeaders := make(map[string]string)
	for k, v := range resp.Header {
		respHeaders[k] = strings.Join(v, ", ")
	}

	replayResp := ReplayResponse{
		StatusCode: resp.StatusCode,
		Headers:    respHeaders,
		Body:       string(respBody),
		Duration:   time.Since(start).String(),
	}

	log.Printf("webhook replayed: request=%s target=%s status=%d duration=%s", requestID, replay.TargetURL, resp.StatusCode, replayResp.Duration)

	writeJSON(w, http.StatusOK, replayResp)
}

// --- Helpers ---

func generateID(length int) string {
	b := make([]byte, length)
	rand.Read(b)
	return hex.EncodeToString(b)[:length]
}

func extractPathParam(path, prefix string) string {
	return strings.TrimPrefix(path, prefix)
}

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func formatDuration(d time.Duration) string {
	days := int(d.Hours()) / 24
	hours := int(d.Hours()) % 24
	minutes := int(d.Minutes()) % 60
	seconds := int(d.Seconds()) % 60

	if days > 0 {
		return fmt.Sprintf("%dd %dh %dm", days, hours, minutes)
	}
	if hours > 0 {
		return fmt.Sprintf("%dh %dm %ds", hours, minutes, seconds)
	}
	if minutes > 0 {
		return fmt.Sprintf("%dm %ds", minutes, seconds)
	}
	return fmt.Sprintf("%ds", seconds)
}

