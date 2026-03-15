package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"time"

	_ "github.com/lib/pq"
)

// DB wraps the sql.DB connection and provides query methods.
type DB struct {
	conn *sql.DB
}

// NewDB connects to PostgreSQL and runs migrations.
func NewDB() (*DB, error) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}

	conn, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}

	conn.SetMaxOpenConns(10)
	conn.SetMaxIdleConns(5)
	conn.SetConnMaxLifetime(5 * time.Minute)

	if err := conn.Ping(); err != nil {
		return nil, fmt.Errorf("ping database: %w", err)
	}

	db := &DB{conn: conn}
	if err := db.migrate(); err != nil {
		return nil, fmt.Errorf("migrate: %w", err)
	}
	log.Println("connected to PostgreSQL")
	return db, nil
}

func (db *DB) migrate() error {
	schema := `
	CREATE TABLE IF NOT EXISTS endpoints (
		id         TEXT PRIMARY KEY,
		name       TEXT NOT NULL DEFAULT '',
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	);

	CREATE TABLE IF NOT EXISTS requests (
		id           TEXT PRIMARY KEY,
		endpoint_id  TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
		method       TEXT NOT NULL,
		headers      TEXT NOT NULL DEFAULT '{}',
		body         TEXT NOT NULL DEFAULT '',
		query_params TEXT NOT NULL DEFAULT '{}',
		source_ip    TEXT NOT NULL DEFAULT '',
		content_type TEXT NOT NULL DEFAULT '',
		size         INTEGER NOT NULL DEFAULT 0,
		received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
	);

	CREATE INDEX IF NOT EXISTS idx_requests_endpoint ON requests(endpoint_id, received_at DESC);
	`
	_, err := db.conn.Exec(schema)
	return err
}

// CreateEndpoint inserts a new endpoint and returns it.
func (db *DB) CreateEndpoint(id, name string) (*Endpoint, error) {
	now := time.Now().UTC()
	_, err := db.conn.Exec(
		"INSERT INTO endpoints (id, name, created_at) VALUES ($1, $2, $3)",
		id, name, now,
	)
	if err != nil {
		return nil, err
	}
	return &Endpoint{
		ID:           id,
		Name:         name,
		CreatedAt:    now,
		RequestCount: 0,
	}, nil
}

// ListEndpoints returns all endpoints ordered by creation time descending.
func (db *DB) ListEndpoints() ([]Endpoint, error) {
	rows, err := db.conn.Query(`
		SELECT e.id, e.name, e.created_at, COUNT(r.id) as request_count
		FROM endpoints e
		LEFT JOIN requests r ON r.endpoint_id = e.id
		GROUP BY e.id, e.name, e.created_at
		ORDER BY e.created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var endpoints []Endpoint
	for rows.Next() {
		var ep Endpoint
		if err := rows.Scan(&ep.ID, &ep.Name, &ep.CreatedAt, &ep.RequestCount); err != nil {
			return nil, err
		}
		endpoints = append(endpoints, ep)
	}
	return endpoints, rows.Err()
}

// GetEndpoint returns a single endpoint by ID.
func (db *DB) GetEndpoint(id string) (*Endpoint, error) {
	var ep Endpoint
	err := db.conn.QueryRow(`
		SELECT e.id, e.name, e.created_at, COUNT(r.id) as request_count
		FROM endpoints e
		LEFT JOIN requests r ON r.endpoint_id = e.id
		WHERE e.id = $1
		GROUP BY e.id, e.name, e.created_at
	`, id).Scan(&ep.ID, &ep.Name, &ep.CreatedAt, &ep.RequestCount)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &ep, nil
}

// DeleteEndpoint removes an endpoint and all its captured requests.
func (db *DB) DeleteEndpoint(id string) error {
	_, err := db.conn.Exec("DELETE FROM endpoints WHERE id = $1", id)
	return err
}

// SaveRequest stores a captured webhook request.
func (db *DB) SaveRequest(req *WebhookRequest) error {
	headersJSON, _ := json.Marshal(req.Headers)
	paramsJSON, _ := json.Marshal(req.QueryParams)

	_, err := db.conn.Exec(`
		INSERT INTO requests (id, endpoint_id, method, headers, body, query_params, source_ip, content_type, size, received_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
	`, req.ID, req.EndpointID, req.Method, string(headersJSON), req.Body,
		string(paramsJSON), req.SourceIP, req.ContentType, req.Size, req.ReceivedAt)
	return err
}

// ListRequests returns the most recent requests for an endpoint.
func (db *DB) ListRequests(endpointID string, limit int) ([]WebhookRequest, error) {
	if limit <= 0 {
		limit = 50
	}

	rows, err := db.conn.Query(`
		SELECT id, endpoint_id, method, headers, body, query_params, source_ip, content_type, size, received_at
		FROM requests
		WHERE endpoint_id = $1
		ORDER BY received_at DESC
		LIMIT $2
	`, endpointID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var requests []WebhookRequest
	for rows.Next() {
		var r WebhookRequest
		var headersStr, paramsStr string
		if err := rows.Scan(&r.ID, &r.EndpointID, &r.Method, &headersStr, &r.Body, &paramsStr, &r.SourceIP, &r.ContentType, &r.Size, &r.ReceivedAt); err != nil {
			return nil, err
		}
		r.Headers = make(map[string]string)
		r.QueryParams = make(map[string]string)
		json.Unmarshal([]byte(headersStr), &r.Headers)
		json.Unmarshal([]byte(paramsStr), &r.QueryParams)
		requests = append(requests, r)
	}
	return requests, rows.Err()
}

// GetRequest returns a single request by ID.
func (db *DB) GetRequest(id string) (*WebhookRequest, error) {
	var r WebhookRequest
	var headersStr, paramsStr string
	err := db.conn.QueryRow(`
		SELECT id, endpoint_id, method, headers, body, query_params, source_ip, content_type, size, received_at
		FROM requests
		WHERE id = $1
	`, id).Scan(&r.ID, &r.EndpointID, &r.Method, &headersStr, &r.Body, &paramsStr, &r.SourceIP, &r.ContentType, &r.Size, &r.ReceivedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.Headers = make(map[string]string)
	r.QueryParams = make(map[string]string)
	json.Unmarshal([]byte(headersStr), &r.Headers)
	json.Unmarshal([]byte(paramsStr), &r.QueryParams)
	return &r, nil
}

// TotalRequests returns the total number of captured webhook requests.
func (db *DB) TotalRequests() int {
	var count int
	db.conn.QueryRow("SELECT COUNT(*) FROM requests").Scan(&count)
	return count
}

// EndpointCount returns the total number of endpoints.
func (db *DB) EndpointCount() int {
	var count int
	db.conn.QueryRow("SELECT COUNT(*) FROM endpoints").Scan(&count)
	return count
}

// Close closes the database connection.
func (db *DB) Close() error {
	return db.conn.Close()
}
