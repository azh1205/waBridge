// mcp-manager.js
// Boots all configured MCP servers and provides a unified tool registry

import { McpClient } from "./mcp-client.js";
import path from "path";

// ─── MCP Server Config ────────────────────────────────────────────────────────
// Matches your mcp.json — adjust paths if needed

const NODE = process.env.NODE_BIN || "C:\\Program Files\\nodejs\\node.exe";
const MCP_BASE = process.env.MCP_BASE || "C:\\Users\\VANDO\\AppData\\Roaming\\LM Studio\\mcp";

const MCP_SERVERS = [
  {
    name: "file-reader",
    command: NODE,
    args: [path.join(MCP_BASE, "file-reader", "server.js")],
    env: {
      ALLOWED_DIR: process.env.ALLOWED_DIR || "C:\\Users\\VANDO\\Documents\\AI_Files",
    },
  },
  {
    name: "web-summarizer",
    command: NODE,
    args: [path.join(MCP_BASE, "web-summarizer", "server.js")],
    env: {},
  },
  {
    name: "github-reader",
    command: NODE,
    args: [path.join(MCP_BASE, "github-reader", "server.js")],
    env: {
      GITHUB_TOKEN: process.env.GITHUB_TOKEN || "",
    },
  },
  {
    name: "memory-mcp",
    command: NODE,
    args: [path.join(MCP_BASE, "memory-mcp", "server.js")],
    env: {
      MEMORY_PORT: process.env.MEMORY_PORT || "3344",
    },
  },
];

// ─── McpManager ───────────────────────────────────────────────────────────────

export class McpManager {
  constructor() {
    this.clients = new Map(); // name → McpClient
    this.allTools = []; // flat list of all tools across servers
    this.toolMap = new Map(); // toolName → McpClient
  }

  async start() {
    console.log("[MCPManager] Starting MCP servers...");

    for (const cfg of MCP_SERVERS) {
      const client = new McpClient(cfg.name, cfg.command, cfg.args, cfg.env);
      try {
        await client.start();
        const tools = await client.loadTools();
        for (const tool of tools) {
          this.toolMap.set(tool.name, client);
        }
        this.allTools.push(...tools);
        this.clients.set(cfg.name, client);
        console.log(`[MCPManager] ✓ ${cfg.name} ready`);
      } catch (err) {
        console.warn(`[MCPManager] ✗ ${cfg.name} failed to start: ${err.message}`);
        // Continue — other servers still work
      }
    }

    console.log(`[MCPManager] Ready. Total tools: ${this.allTools.length}`);
    return this.allTools;
  }

  // Returns tools formatted for LM Studio's OpenAI-compatible tools param
  getToolsForLLM() {
    return this.allTools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema || { type: "object", properties: {} },
      },
    }));
  }

  // Execute a tool call from the LLM
  async executeTool(toolName, toolArgs) {
    const client = this.toolMap.get(toolName);
    if (!client) {
      throw new Error(`No MCP server handles tool: ${toolName}`);
    }
    console.log(`[MCPManager] Calling tool "${toolName}" on server "${client.name}"`);
    return await client.callTool(toolName, toolArgs);
  }

  // Check which servers are alive
  status() {
    const result = {};
    for (const [name, client] of this.clients) {
      result[name] = { ready: client.ready, tools: client.tools.map((t) => t.name) };
    }
    return result;
  }

  stopAll() {
    for (const client of this.clients.values()) {
      client.stop();
    }
    console.log("[MCPManager] All MCP servers stopped.");
  }
}
