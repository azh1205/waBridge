// mcp-client.js
// Spawns an MCP server as a child process and communicates via JSON-RPC over stdio

import { spawn } from "child_process";
import { EventEmitter } from "events";

export class McpClient extends EventEmitter {
  constructor(name, command, args, env = {}) {
    super();
    this.name = name;
    this.command = command;
    this.args = args;
    this.env = env;
    this.process = null;
    this.tools = [];
    this.ready = false;
    this._pending = new Map(); // id → { resolve, reject }
    this._msgId = 1;
    this._buffer = "";
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.process = spawn(this.command, this.args, {
        env: { ...process.env, ...this.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.process.stderr.on("data", (d) => {
        // MCP servers may log to stderr — ignore silently
      });

      this.process.stdout.on("data", (chunk) => {
        this._buffer += chunk.toString();
        const lines = this._buffer.split("\n");
        this._buffer = lines.pop(); // keep incomplete last line
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed);
            this._handleMessage(msg);
          } catch {
            // ignore non-JSON
          }
        }
      });

      this.process.on("error", (err) => {
        console.error(`[MCP:${this.name}] Process error:`, err.message);
        reject(err);
      });

      this.process.on("exit", (code) => {
        console.warn(`[MCP:${this.name}] Process exited (code ${code})`);
        // Reject any pending requests
        for (const [, { reject }] of this._pending) {
          reject(new Error(`MCP server "${this.name}" exited`));
        }
        this._pending.clear();
        this.ready = false;
      });

      // Initialize the MCP server
      this._send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "whatsapp-bridge", version: "1.0.0" },
      })
        .then((res) => {
          // Send initialized notification
          this._notify("notifications/initialized");
          resolve(res);
        })
        .catch(reject);
    });
  }

  async loadTools() {
    try {
      const res = await this._send("tools/list", {});
      this.tools = (res.tools || []).map((t) => ({
        ...t,
        // Tag the tool with the server name so we know who to call
        _server: this.name,
      }));
      console.log(`[MCP:${this.name}] Loaded ${this.tools.length} tools: ${this.tools.map((t) => t.name).join(", ")}`);
      this.ready = true;
      return this.tools;
    } catch (err) {
      console.error(`[MCP:${this.name}] Failed to load tools:`, err.message);
      return [];
    }
  }

  async callTool(toolName, toolArgs) {
    const res = await this._send("tools/call", {
      name: toolName,
      arguments: toolArgs,
    });
    // Extract text content from MCP response
    if (res?.content) {
      return res.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    }
    return JSON.stringify(res);
  }

  stop() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  _send(method, params) {
    return new Promise((resolve, reject) => {
      const id = this._msgId++;
      this._pending.set(id, { resolve, reject });

      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.process.stdin.write(msg + "\n");

      // Timeout after 15s
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`Timeout waiting for response to "${method}" from ${this.name}`));
        }
      }, 15000);
    });
  }

  _notify(method, params = {}) {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.process.stdin.write(msg + "\n");
  }

  _handleMessage(msg) {
    if (msg.id !== undefined && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        resolve(msg.result);
      }
    }
  }
}
