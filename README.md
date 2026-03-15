# WebhookRelay

A self-hosted webhook inspection and relay tool. Catch, inspect, and replay HTTP requests in real-time.

## Features

- Generate unique webhook endpoints
- Receive any HTTP method and payload
- View incoming webhooks in real-time via WebSocket
- Replay/forward webhooks to another URL
- Full request details: method, headers, body, query params

## Quick Start

```bash
go build -o webhook-relay .
./webhook-relay
```

Open http://localhost:8080 in your browser.

## Docker

```bash
docker build -t webhook-relay .
docker run -p 8080:8080 webhook-relay
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server listen port |
| `DB_PATH` | `webhooks.db` | SQLite database file path |

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/api/endpoints` | List endpoints |
| `POST` | `/api/endpoints` | Create endpoint |
| `GET` | `/api/endpoints/:id` | Get endpoint |
| `DELETE` | `/api/endpoints/:id` | Delete endpoint |
| `GET` | `/api/endpoints/:id/requests` | List captured requests |
| `ANY` | `/hook/:id` | Webhook catch-all |
| `POST` | `/api/requests/:id/replay` | Replay a request |
| `GET` | `/api/stats` | System statistics |
| `GET` | `/ws` | WebSocket connection |
