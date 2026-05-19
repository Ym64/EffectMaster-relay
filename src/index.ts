import {DurableObject} from "cloudflare:workers"

// This is the "environment" type — it describes what bindings
// are available to your Worker (matches wrangler.toml)
interface Env {
	SESSIONS: DurableObjectNamespace
}

// ─── Main Worker ────────────────────────────────────────────────
// This handles every incoming HTTP request and routes it to the
// right Durable Object based on the session code in the URL.
export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url)

		// Expected URL format:
		// wss://effectmaster-relay.YOUR-SUBDOMAIN.workers.dev?code=X7K2&role=plugin
		// wss://effectmaster-relay.YOUR-SUBDOMAIN.workers.dev?code=X7K2&role=editor
		const code = url.searchParams.get("code")
		const role = url.searchParams.get("role")

		if (!code || !role) {
			return new Response("Missing ?code or ?role parameter", {status: 400})
		}

		if (role !== "plugin" && role !== "editor") {
			return new Response("role must be 'plugin' or 'editor'", {status: 400})
		}

		if (req.headers.get("Upgrade") !== "websocket") {
			return new Response("This endpoint only accepts WebSocket connections", {status: 426})
		}

		// Get (or create) the Durable Object for this session code.
		// idFromName("X7K2") always returns the same DO for the same code —
		// that's how both connections end up in the same object.
		const doId = env.SESSIONS.idFromName(code)
		const session = env.SESSIONS.get(doId)

		// Forward the request to the Durable Object
		return session.fetch(req)
	}
}

// ─── Durable Object ─────────────────────────────────────────────
// One instance of this class exists per session code.
// It holds both WebSocket connections and bridges messages between them.
export class EditorSession extends DurableObject {

	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url)
		const role = url.searchParams.get("role")!  // "plugin" or "editor"

		// Create the WebSocket pair:
		// - client goes back to whoever connected (the plugin or the editor)
		// - server stays here inside the Durable Object
		const {0: client, 1: server} = new WebSocketPair()

		// acceptWebSocket registers the server-side socket with the hibernation API.
		// The second argument is a list of "tags" we can use to look up this socket later.
		this.ctx.acceptWebSocket(server, [role])

		// 101 Switching Protocols — standard WebSocket handshake response
		return new Response(null, {status: 101, webSocket: client})
	}

	// Called automatically by Cloudflare when any hibernated WebSocket
	// belonging to this DO receives a message
	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		if (typeof message === "string") {
			const msg = JSON.parse(message)
			if (msg.type === "PING") {
				ws.send(JSON.stringify({type: "PONG"}))
				return
			}
		}

		const tags = this.ctx.getTags(ws)
		const senderRole = tags[0]  // "plugin" or "editor"

		// Find the socket(s) on the other side
		const targetRole = senderRole === "plugin" ? "editor" : "plugin"
		const targets = this.ctx.getWebSockets(targetRole)

		if (targets.length === 0) {
			// Other side not connected yet — send feedback to sender
			ws.send(JSON.stringify({
				type: "ERROR",
				message: `No ${targetRole} connected to this session yet.`
			}))
			return
		}

		// Forward the message to all sockets with the target role
		for (const target of targets) {
			target.send(message)
		}
	}

	async webSocketClose(ws: WebSocket, code: number) {
		const [role] = this.ctx.getTags(ws)

		// When the editor (browser) closes, notify the plugin so it can
		// show a message in-game
		if (role === "editor") {
			const pluginSockets = this.ctx.getWebSockets("plugin")
			for (const plugin of pluginSockets) {
				plugin.send(JSON.stringify({type: "EDITOR_DISCONNECTED"}))
			}
		}

		// When the plugin closes, notify the browser so it can show
		// a message
		if (role === "plugin") {
			const editorSockets = this.ctx.getWebSockets("editor")
			for (const editor of editorSockets) {
				editor.send(JSON.stringify({type: "EDITOR_DISCONNECTED"}))
			}
		}
	}

	async webSocketError(ws: WebSocket, error: unknown) {
		console.error("WebSocket error:", error)
	}
}
