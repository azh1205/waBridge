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
        description: typeof t.description === "string" && t.description.trim()
          ? t.description
          : `Execute tool ${t.name}`,
        parameters: normalizeToolSchema(t.inputSchema),
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

function normalizeToolSchema(schema) {
  return normalizeSchemaNode(schema, "input");
}

function normalizeSchemaNode(schema, fieldName) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return {
      type: "object",
      description: `${fieldName} input`,
      properties: {},
      required: [],
      additionalProperties: false,
    };
  }

  const type = typeof schema.type === "string" ? schema.type : inferSchemaType(schema);

  if (type === "object") {
    const rawProps =
      schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
        ? schema.properties
        : {};

    const properties = {};
    for (const [key, value] of Object.entries(rawProps)) {
      properties[key] = normalizeSchemaNode(value, key);
    }

    const required = Array.isArray(schema.required)
      ? schema.required.filter((key) => typeof key === "string" && key in properties)
      : [];

    return {
      type: "object",
      description: typeof schema.description === "string" && schema.description.trim()
        ? schema.description
        : `${fieldName} object`,
      properties,
      required,
      additionalProperties: false,
    };
  }

  if (type === "array") {
    return {
      type: "array",
      description: typeof schema.description === "string" && schema.description.trim()
        ? schema.description
        : `${fieldName} list`,
      items: normalizeArrayItems(schema.items, fieldName),
    };
  }

  const normalized = {
    type: isPrimitiveType(type) ? type : "string",
  };

  if (typeof schema.description === "string" && schema.description.trim()) {
    normalized.description = schema.description;
  }

  if (Array.isArray(schema.enum) && schema.enum.length) {
    normalized.enum = schema.enum.filter((value) =>
      ["string", "number", "integer", "boolean"].includes(typeof value) || value === null
    );
  }

  return normalized;
}

function normalizeArrayItems(items, fieldName) {
  if (!items || typeof items !== "object" || Array.isArray(items)) {
    return {
      type: "string",
      description: `${fieldName} item`,
    };
  }

  const normalized = normalizeSchemaNode(items, `${fieldName}_item`);
  if (normalized.type === "object" && !("additionalProperties" in normalized)) {
    normalized.additionalProperties = false;
  }
  return normalized;
}

function inferSchemaType(schema) {
  if (schema.properties) return "object";
  if (schema.items) return "array";
  return "string";
}

function isPrimitiveType(type) {
  return ["string", "number", "integer", "boolean", "null"].includes(type);
}
