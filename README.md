# WhatsApp LLM Bridge Server

Connects the Chrome extension → LM Studio + all 4 MCP tools.

## Full Flow

```
WhatsApp Web
    ↓  keyword matched
Chrome Extension
    ↓  POST /suggest
Bridge Server (port 3000)
    ↓  spawns on startup
┌─────────────────────────────────┐
│  file-reader MCP                │
│  web-summarizer MCP             │
│  github-reader MCP              │
│  memory-mcp MCP                 │
└─────────────────────────────────┘
    ↓  tool calls (if needed)
LM Studio (port 1234)
    ↓  final text reply
Chrome Extension shows suggestion panel
```

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure paths
Copy `.env.example` to `.env` and fill in your values:
```bash
copy .env.example .env
```
Edit `.env`:
- Set `GITHUB_TOKEN` to your GitHub PAT
- Confirm `NODE_BIN` path matches your Node.js install
- Confirm `MCP_BASE` points to your LM Studio mcp folder

### 3. Start LM Studio
- Load a model → Local Server tab → Start Server

### 4. Start the bridge
```bash
npm start
```

You'll see each MCP server start and list its tools:
```
[MCPManager] ✓ file-reader ready
[MCPManager] ✓ web-summarizer ready
[MCPManager] ✓ github-reader ready
[MCPManager] ✓ memory-mcp ready
[MCPManager] Ready. Total tools: 12
```

### 5. Check status
Open http://localhost:3000/status in your browser to verify everything is connected.

## How the LLM uses tools

When the extension sends a message, the bridge:
1. Sends the message + all MCP tools to LM Studio
2. If LM Studio calls a tool → bridge executes it via the MCP server
3. Tool result is fed back to LM Studio
4. This loops up to 5 times (configurable via `MAX_TOOL_ROUNDS`)
5. Final text reply is returned to the extension

**Example**: User asks "can you check my notes on project X?" → LLM calls `search_files` → file-reader searches `AI_Files` → result returned → LLM writes a reply based on the file content.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | LM Studio + MCP server status |
| GET | `/status` | Full status with tool list |
| POST | `/suggest` | Generate reply (called by extension) |

### POST /suggest body
```json
{
  "message": "Can you check my notes?",
  "contactName": "Budi",
  "chatHistory": [],
  "model": "llama-3.2-3b-instruct",
  "systemPrompt": "You are a helpful WhatsApp assistant."
}
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| MCP server fails to start | Check NODE_BIN path. Run `node --version` to verify |
| Tools not appearing | Check MCP_BASE path — server.js files must exist there |
| LM Studio offline | Start Local Server in LM Studio first |
| Tool calls not working | Some models don't support tool use well — try a larger model |
| Port 3000 in use | Change PORT in .env and update extension's `MCP_SERVER` in background.js |
