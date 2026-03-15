// WebhookRelay Frontend Application
(function () {
	"use strict";

	const state = {
		endpoints: [],
		currentEndpointId: null,
		requests: {},
		ws: null,
		wsRetryCount: 0,
		startTime: Date.now(),
		replayRequestId: null,
	};

	// ---------------------------------------------------------------------------
	// Utilities
	// ---------------------------------------------------------------------------

	function getBaseURL() {
		return window.location.origin;
	}

	function getWebhookURL(endpointId) {
		return getBaseURL() + "/hook/" + endpointId;
	}

	function timeAgo(dateStr) {
		const now = new Date();
		const date = new Date(dateStr);
		const seconds = Math.floor((now - date) / 1000);
		if (seconds < 5) return "just now";
		if (seconds < 60) return seconds + "s ago";
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return minutes + "m ago";
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return hours + "h ago";
		const days = Math.floor(hours / 24);
		return days + "d ago";
	}

	function escapeHtml(str) {
		const div = document.createElement("div");
		div.textContent = str;
		return div.innerHTML;
	}

	function syntaxHighlightJSON(json) {
		if (typeof json !== "string") return escapeHtml(String(json));
		try {
			const parsed = JSON.parse(json);
			json = JSON.stringify(parsed, null, 2);
		} catch (e) {
			return escapeHtml(json);
		}
		return json.replace(
			/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
			function (match) {
				let cls = "json-number";
				if (/^"/.test(match)) {
					if (/:$/.test(match)) {
						cls = "json-key";
						// Remove the trailing colon for display, we'll add it back
						return '<span class="' + cls + '">' + escapeHtml(match.slice(0, -1)) + "</span>:";
					} else {
						cls = "json-string";
					}
				} else if (/true|false/.test(match)) {
					cls = "json-boolean";
				} else if (/null/.test(match)) {
					cls = "json-null";
				}
				return '<span class="' + cls + '">' + escapeHtml(match) + "</span>";
			}
		);
	}

	function getMethodClass(method) {
		return "method-" + method.toLowerCase();
	}

	// ---------------------------------------------------------------------------
	// API
	// ---------------------------------------------------------------------------

	async function api(path, options) {
		const resp = await fetch("/api" + path, {
			headers: { "Content-Type": "application/json" },
			...options,
		});
		if (!resp.ok) {
			const err = await resp.json().catch(() => ({ error: "Unknown error" }));
			throw new Error(err.error || "Request failed");
		}
		if (resp.status === 204) return null;
		return resp.json();
	}

	// ---------------------------------------------------------------------------
	// WebSocket
	// ---------------------------------------------------------------------------

	function connectWebSocket() {
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const url = protocol + "//" + window.location.host + "/ws";

		state.ws = new WebSocket(url);

		state.ws.onopen = function () {
			state.wsRetryCount = 0;
			updateConnectionStatus(true);
		};

		state.ws.onclose = function () {
			updateConnectionStatus(false);
			const delay = Math.min(1000 * Math.pow(2, state.wsRetryCount), 10000);
			state.wsRetryCount++;
			setTimeout(connectWebSocket, delay);
		};

		state.ws.onerror = function () {
			state.ws.close();
		};

		state.ws.onmessage = function (event) {
			try {
				const msg = JSON.parse(event.data);
				handleWSMessage(msg);
			} catch (e) {
				console.error("Failed to parse WS message:", e);
			}
		};
	}

	function handleWSMessage(msg) {
		switch (msg.type) {
			case "webhook_received":
				handleNewRequest(msg.payload);
				break;
			case "endpoint_created":
				loadEndpoints();
				break;
			case "endpoint_deleted":
				loadEndpoints();
				if (state.currentEndpointId === msg.payload.id) {
					state.currentEndpointId = null;
					showHero();
				}
				break;
		}
	}

	function handleNewRequest(req) {
		// Add to local state
		if (!state.requests[req.endpoint_id]) {
			state.requests[req.endpoint_id] = [];
		}
		state.requests[req.endpoint_id].unshift(req);

		// Update endpoint request count in sidebar
		const ep = state.endpoints.find(function (e) { return e.id === req.endpoint_id; });
		if (ep) {
			ep.request_count++;
			renderSidebar();
		}

		// If this is the currently viewed endpoint, add the card with animation
		if (state.currentEndpointId === req.endpoint_id) {
			prependRequestCard(req, true);
			updateRequestCount();
		}

		showToast(req.method + " webhook received", "success");
	}

	function updateConnectionStatus(connected) {
		const dot = document.getElementById("status-dot");
		const text = document.getElementById("status-text");
		if (connected) {
			dot.className = "w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse";
			text.textContent = "Connected";
			text.className = "text-xs text-zinc-400";
		} else {
			dot.className = "w-1.5 h-1.5 rounded-full bg-red-400";
			text.textContent = "Reconnecting...";
			text.className = "text-xs text-red-400";
		}
	}

	// ---------------------------------------------------------------------------
	// Rendering
	// ---------------------------------------------------------------------------

	function renderSidebar() {
		const container = document.getElementById("endpoint-list");
		if (state.endpoints.length === 0) {
			container.innerHTML =
				'<div class="text-center py-8 text-zinc-600 text-xs">No endpoints yet</div>';
			return;
		}

		container.innerHTML = state.endpoints
			.map(function (ep) {
				const isActive = ep.id === state.currentEndpointId;
				return (
					'<button onclick="app.selectEndpoint(\'' +
					ep.id +
					'\')" class="endpoint-item w-full text-left px-3 py-2.5 rounded-lg border border-transparent ' +
					(isActive ? "active" : "") +
					'">' +
					'<div class="flex items-center justify-between">' +
					'<span class="endpoint-id text-sm font-mono font-medium ' +
					(isActive ? "text-emerald-400" : "text-zinc-300") +
					'">' +
					escapeHtml(ep.name) +
					"</span>" +
					'<span class="text-xs px-1.5 py-0.5 rounded-md bg-zinc-800 text-zinc-500 font-mono">' +
					ep.request_count +
					"</span>" +
					"</div>" +
					'<div class="text-xs text-zinc-600 mt-0.5 font-mono">/hook/' +
					ep.id +
					"</div>" +
					"</button>"
				);
			})
			.join("");
	}

	function showHero() {
		document.getElementById("hero-section").classList.remove("hidden");
		document.getElementById("endpoint-detail").classList.add("hidden");
	}

	function showEndpointDetail() {
		document.getElementById("hero-section").classList.add("hidden");
		document.getElementById("endpoint-detail").classList.remove("hidden");
	}

	function renderEndpointDetail(endpoint) {
		document.getElementById("endpoint-name").textContent = endpoint.name;
		document.getElementById("endpoint-created").textContent = timeAgo(endpoint.created_at);

		const webhookURL = getWebhookURL(endpoint.id);
		document.getElementById("webhook-url").textContent = webhookURL;

		const curlCmd =
			"curl -X POST " +
			webhookURL +
			" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\"event\": \"user.signup\", \"user\": {\"id\": 42, \"email\": \"test@example.com\"}}'";
		document.getElementById("curl-command").textContent = curlCmd;

		showEndpointDetail();
	}

	function renderRequestList(requests) {
		const container = document.getElementById("request-list");
		const emptyState = document.getElementById("empty-requests");

		if (!requests || requests.length === 0) {
			// Clear everything except the empty state
			const cards = container.querySelectorAll(".request-card");
			cards.forEach(function (c) { c.remove(); });
			emptyState.classList.remove("hidden");
			updateRequestCount();
			return;
		}

		emptyState.classList.add("hidden");

		// Clear old cards
		const oldCards = container.querySelectorAll(".request-card");
		oldCards.forEach(function (c) { c.remove(); });

		// Prepend before the empty state
		requests.forEach(function (req) {
			prependRequestCard(req, false);
		});
		updateRequestCount();
	}

	function prependRequestCard(req, animate) {
		const container = document.getElementById("request-list");
		const emptyState = document.getElementById("empty-requests");
		emptyState.classList.add("hidden");

		const card = document.createElement("div");
		card.className =
			"request-card bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden" +
			(animate ? " request-card-enter" : "");
		card.setAttribute("data-request-id", req.id);

		const bodyPreview = req.body ? req.body.substring(0, 100) + (req.body.length > 100 ? "..." : "") : "";
		let prettyBody = "";
		try {
			prettyBody = syntaxHighlightJSON(req.body);
		} catch (e) {
			prettyBody = escapeHtml(req.body || "");
		}

		const headerRows = Object.keys(req.headers || {})
			.map(function (k) {
				return (
					"<tr><td>" +
					escapeHtml(k) +
					"</td><td>" +
					escapeHtml(req.headers[k]) +
					"</td></tr>"
				);
			})
			.join("");

		const queryRows = Object.keys(req.query_params || {})
			.map(function (k) {
				return (
					"<tr><td>" +
					escapeHtml(k) +
					"</td><td>" +
					escapeHtml(req.query_params[k]) +
					"</td></tr>"
				);
			})
			.join("");

		card.innerHTML =
			'<div class="cursor-pointer" onclick="this.parentElement.querySelector(\'.request-detail\').classList.toggle(\'hidden\')">' +
			'<div class="px-4 py-3 flex items-center gap-3">' +
			'<span class="method-badge ' + getMethodClass(req.method) + '">' + req.method + "</span>" +
			'<div class="flex-1 min-w-0">' +
			'<span class="text-xs text-zinc-400 font-mono truncate block">' +
			(bodyPreview ? escapeHtml(bodyPreview) : '<span class="text-zinc-600 italic">Empty body</span>') +
			"</span>" +
			"</div>" +
			'<div class="flex items-center gap-3 text-xs text-zinc-500 flex-shrink-0">' +
			'<span title="Size">' + formatBytes(req.size) + "</span>" +
			"<span>" + escapeHtml(req.source_ip) + "</span>" +
			"<span>" + timeAgo(req.received_at) + "</span>" +
			"</div>" +
			"</div>" +
			"</div>" +
			'<div class="request-detail hidden border-t border-zinc-800">' +
			'<div class="p-4 space-y-4">' +
			// Headers
			'<div>' +
			'<h4 class="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Headers</h4>' +
			(headerRows
				? '<div class="bg-zinc-950 rounded-lg border border-zinc-800 overflow-auto max-h-48"><table class="headers-table"><tbody>' +
				  headerRows +
				  "</tbody></table></div>"
				: '<span class="text-xs text-zinc-600 italic">No headers</span>') +
			"</div>" +
			// Query Params
			(queryRows
				? '<div>' +
				  '<h4 class="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Query Parameters</h4>' +
				  '<div class="bg-zinc-950 rounded-lg border border-zinc-800 overflow-auto max-h-48"><table class="headers-table"><tbody>' +
				  queryRows +
				  "</tbody></table></div>" +
				  "</div>"
				: "") +
			// Body
			'<div>' +
			'<h4 class="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">Body</h4>' +
			(req.body
				? '<pre class="bg-zinc-950 rounded-lg border border-zinc-800 p-3 text-xs font-mono overflow-auto max-h-64 whitespace-pre-wrap">' +
				  prettyBody +
				  "</pre>"
				: '<span class="text-xs text-zinc-600 italic">Empty body</span>') +
			"</div>" +
			// Actions
			'<div class="flex items-center gap-2 pt-2">' +
			'<button onclick="event.stopPropagation(); app.openReplay(\'' +
			req.id +
			'\')" class="flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-xs font-medium text-zinc-300 transition-all">' +
			'<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>' +
			"Replay" +
			"</button>" +
			'<span class="text-xs text-zinc-600 font-mono">' +
			req.id +
			"</span>" +
			"</div>" +
			"</div>" +
			"</div>";

		// Insert at the top (before empty state or first card)
		const firstCard = container.querySelector(".request-card");
		if (firstCard) {
			container.insertBefore(card, firstCard);
		} else {
			container.insertBefore(card, emptyState);
		}
	}

	function updateRequestCount() {
		const requests = state.requests[state.currentEndpointId] || [];
		document.getElementById("request-count").textContent = requests.length;
	}

	function formatBytes(bytes) {
		if (bytes === 0) return "0 B";
		if (bytes < 1024) return bytes + " B";
		return (bytes / 1024).toFixed(1) + " KB";
	}

	// ---------------------------------------------------------------------------
	// Actions
	// ---------------------------------------------------------------------------

	async function loadEndpoints() {
		try {
			state.endpoints = await api("/endpoints");
			renderSidebar();

			// Show/hide sidebar based on endpoints
			const sidebar = document.getElementById("sidebar");
			if (state.endpoints.length > 0) {
				sidebar.classList.remove("lg:hidden");
				sidebar.classList.add("lg:flex");
			}

			// If we have endpoints but none selected, show hero with sidebar visible
			if (state.endpoints.length > 0 && !state.currentEndpointId) {
				// Auto-select the first one
				selectEndpoint(state.endpoints[0].id);
			} else if (state.endpoints.length === 0) {
				showHero();
			}
		} catch (e) {
			console.error("Failed to load endpoints:", e);
		}
	}

	async function createEndpoint() {
		try {
			const ep = await api("/endpoints", {
				method: "POST",
				body: JSON.stringify({}),
			});
			await loadEndpoints();
			selectEndpoint(ep.id);
			showToast("Endpoint created: /hook/" + ep.id, "success");
		} catch (e) {
			showToast("Failed to create endpoint: " + e.message, "error");
		}
	}

	async function selectEndpoint(id) {
		state.currentEndpointId = id;
		renderSidebar();

		const ep = state.endpoints.find(function (e) { return e.id === id; });
		if (!ep) return;

		renderEndpointDetail(ep);

		// Load requests
		try {
			const requests = await api("/endpoints/" + id + "/requests");
			state.requests[id] = requests;
			renderRequestList(requests);
		} catch (e) {
			console.error("Failed to load requests:", e);
		}
	}

	async function deleteCurrentEndpoint() {
		if (!state.currentEndpointId) return;
		if (!confirm("Delete this endpoint and all its captured webhooks?")) return;

		try {
			await api("/endpoints/" + state.currentEndpointId, { method: "DELETE" });
			state.currentEndpointId = null;
			await loadEndpoints();
			if (state.endpoints.length === 0) {
				showHero();
			}
			showToast("Endpoint deleted", "success");
		} catch (e) {
			showToast("Failed to delete: " + e.message, "error");
		}
	}

	async function sendTestWebhook() {
		if (!state.currentEndpointId) return;

		const url = getWebhookURL(state.currentEndpointId);
		const payload = {
			event: "order.completed",
			data: {
				order_id: "ord_" + Math.random().toString(36).substring(2, 10),
				customer: {
					name: "Jane Doe",
					email: "jane@example.com",
				},
				items: [
					{ product: "Widget Pro", quantity: 2, price: 29.99 },
					{ product: "Gadget Plus", quantity: 1, price: 49.99 },
				],
				total: 109.97,
				currency: "USD",
			},
			timestamp: new Date().toISOString(),
		};

		try {
			await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
		} catch (e) {
			showToast("Failed to send test webhook: " + e.message, "error");
		}
	}

	function copyWebhookURL() {
		if (!state.currentEndpointId) return;
		const url = getWebhookURL(state.currentEndpointId);
		navigator.clipboard.writeText(url).then(function () {
			const copyIcon = document.getElementById("copy-icon");
			const checkIcon = document.getElementById("check-icon");
			copyIcon.classList.add("hidden");
			checkIcon.classList.remove("hidden");
			setTimeout(function () {
				copyIcon.classList.remove("hidden");
				checkIcon.classList.add("hidden");
			}, 2000);
			showToast("URL copied to clipboard", "success");
		});
	}

	// ---------------------------------------------------------------------------
	// Replay
	// ---------------------------------------------------------------------------

	function openReplay(requestId) {
		state.replayRequestId = requestId;
		document.getElementById("replay-url").value = "";
		document.getElementById("replay-result").classList.add("hidden");
		document.getElementById("replay-modal").classList.remove("hidden");
		document.getElementById("replay-url").focus();
	}

	function closeReplay() {
		document.getElementById("replay-modal").classList.add("hidden");
		state.replayRequestId = null;
	}

	async function executeReplay() {
		const targetURL = document.getElementById("replay-url").value.trim();
		if (!targetURL) {
			showToast("Please enter a target URL", "error");
			return;
		}

		try {
			const result = await api("/requests/" + state.replayRequestId + "/replay", {
				method: "POST",
				body: JSON.stringify({ target_url: targetURL }),
			});

			const statusEl = document.getElementById("replay-status");
			statusEl.textContent = result.status_code + " (" + result.duration + ")";
			statusEl.className =
				"text-xs font-mono font-semibold " +
				(result.status_code < 400 ? "text-emerald-400" : "text-red-400");

			document.getElementById("replay-response-body").textContent =
				result.body || "(empty response)";
			document.getElementById("replay-result").classList.remove("hidden");
			showToast("Webhook replayed successfully", "success");
		} catch (e) {
			showToast("Replay failed: " + e.message, "error");
		}
	}

	// ---------------------------------------------------------------------------
	// Stats
	// ---------------------------------------------------------------------------

	async function showStats() {
		document.getElementById("stats-modal").classList.remove("hidden");
		try {
			const stats = await api("/stats");
			document.getElementById("stats-content").innerHTML =
				'<div class="stat-card"><span class="stat-label">Uptime</span><span class="stat-value">' +
				escapeHtml(stats.uptime) +
				"</span></div>" +
				'<div class="stat-card"><span class="stat-label">Webhooks Received</span><span class="stat-value">' +
				stats.webhooks_received +
				"</span></div>" +
				'<div class="stat-card"><span class="stat-label">Endpoints</span><span class="stat-value">' +
				stats.endpoint_count +
				"</span></div>" +
				'<div class="stat-card"><span class="stat-label">Database Size</span><span class="stat-value">' +
				escapeHtml(stats.db_size_human) +
				"</span></div>" +
				'<div class="stat-card"><span class="stat-label">WebSocket Connections</span><span class="stat-value">' +
				stats.ws_connections +
				"</span></div>" +
				'<div class="stat-card"><span class="stat-label">Memory Usage</span><span class="stat-value">' +
				escapeHtml(stats.memory_mb) +
				" MB</span></div>" +
				'<div class="stat-card"><span class="stat-label">Go Version</span><span class="stat-value">' +
				escapeHtml(stats.go_version) +
				"</span></div>";
		} catch (e) {
			document.getElementById("stats-content").innerHTML =
				'<div class="text-center py-4 text-red-400 text-sm">Failed to load stats</div>';
		}
	}

	function closeStats() {
		document.getElementById("stats-modal").classList.add("hidden");
	}

	// ---------------------------------------------------------------------------
	// Toast Notifications
	// ---------------------------------------------------------------------------

	function showToast(message, type) {
		const container = document.getElementById("toast-container");
		const toast = document.createElement("div");

		const bgColor = type === "error" ? "bg-red-500/15 border-red-500/30" : "bg-emerald-500/15 border-emerald-500/30";
		const textColor = type === "error" ? "text-red-300" : "text-emerald-300";
		const iconColor = type === "error" ? "text-red-400" : "text-emerald-400";

		toast.className = "toast-enter flex items-center gap-2 px-4 py-2.5 rounded-xl border backdrop-blur-lg " + bgColor;
		toast.innerHTML =
			'<svg class="w-3.5 h-3.5 flex-shrink-0 ' + iconColor + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
			(type === "error"
				? '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'
				: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>') +
			"</svg>" +
			'<span class="text-sm ' + textColor + '">' + escapeHtml(message) + "</span>";

		container.appendChild(toast);

		setTimeout(function () {
			toast.className = toast.className.replace("toast-enter", "toast-exit");
			setTimeout(function () {
				toast.remove();
			}, 200);
		}, 3000);
	}

	// ---------------------------------------------------------------------------
	// Uptime Counter
	// ---------------------------------------------------------------------------

	function updateUptime() {
		const seconds = Math.floor((Date.now() - state.startTime) / 1000);
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const s = seconds % 60;

		let text = "";
		if (h > 0) text += h + "h ";
		if (m > 0 || h > 0) text += m + "m ";
		text += s + "s";

		document.getElementById("uptime-counter").textContent = text;
	}

	// ---------------------------------------------------------------------------
	// Initialization
	// ---------------------------------------------------------------------------

	async function init() {
		connectWebSocket();
		await loadEndpoints();

		// Auto-create a demo endpoint if none exist
		if (state.endpoints.length === 0) {
			await createEndpoint();
		}

		// Update uptime every second
		setInterval(updateUptime, 1000);
		updateUptime();
	}

	// Expose public API
	window.app = {
		createEndpoint: createEndpoint,
		selectEndpoint: selectEndpoint,
		deleteCurrentEndpoint: deleteCurrentEndpoint,
		sendTestWebhook: sendTestWebhook,
		copyWebhookURL: copyWebhookURL,
		openReplay: openReplay,
		closeReplay: closeReplay,
		executeReplay: executeReplay,
		showStats: showStats,
		closeStats: closeStats,
	};

	// Start
	document.addEventListener("DOMContentLoaded", init);
})();
