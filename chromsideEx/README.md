# WhatsApp LLM Assistant

Auto-suggest WhatsApp replies using your **local LM Studio** model — triggered by keywords, approved before sending.

```
WhatsApp Web → Chrome Extension → MCP Bridge Server → LM Studio → Reply Suggestion
```

---

## 📁 Project Structure

```
whatsapp-llm/
├── extension/          # Chrome Extension (load into browser)
│   ├── manifest.json
│   ├── background.js   # Service worker, talks to MCP server
│   ├── content.js      # Injected into WhatsApp Web
│   ├── panel.css       # Suggestion panel styles
│   ├── popup.html      # Settings popup
│   └── popup.js
└── mcp-server/         # Node.js MCP Bridge Server
    ├── server.js
    └── package.json
```

---

## 🚀 Setup

### Step 1 — Start LM Studio
1. Open LM Studio
2. Load any model (e.g. `llama-3.2-3b-instruct`)
3. Go to **Local Server** tab → click **Start Server**
4. Default URL: `http://localhost:1234`

### Step 2 — Start MCP Bridge Server
```bash
cd mcp-server
npm install
npm start
```

Optional env vars:
```bash
LM_STUDIO_URL=http://localhost:1234  # default
DEFAULT_MODEL=llama-3.2-3b-instruct  # match your loaded model
```

### Step 3 — Load Chrome Extension
1. Open Chrome → go to `chrome://extensions`
2. Enable **Developer Mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder
5. Pin the extension to your toolbar

### Step 4 — Configure Keywords
1. Click the extension icon in toolbar
2. Set your trigger keywords (e.g. `help, support, halo, hai, info`)
3. Set the model name to match your LM Studio model
4. Customize the system prompt if desired
5. Click **Save Settings**

### Step 5 — Use It
1. Open [web.whatsapp.com](https://web.whatsapp.com)
2. When someone sends a message containing a keyword, a **suggestion panel** appears
3. Review/edit the suggested reply
4. Click **Send** to inject it into the input box (you still press Enter to send)
5. Click **↺ Regenerate** to get a new suggestion

---

## ⚙️ MCP Server Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Check server + LM Studio status |
| GET | `/models` | List available LM Studio models |
| POST | `/suggest` | Generate reply suggestion |
| POST | `/mcp` | MCP tool protocol (tools/list, tools/call) |

### POST /suggest — Request Body
```json
{
  "message": "Can you help me with my order?",
  "contactName": "Budi",
  "chatHistory": [
    { "role": "user", "content": "Hi there" },
    { "role": "assistant", "content": "Hello! How can I help?" }
  ],
  "model": "llama-3.2-3b-instruct",
  "systemPrompt": "You are a helpful WhatsApp assistant..."
}
```

---

## 🔧 Troubleshooting

| Problem | Fix |
|---------|-----|
| Panel doesn't appear | Reload WhatsApp Web after installing extension |
| Server offline in popup | Make sure `npm start` is running in `mcp-server/` |
| LM Studio error | Confirm Local Server is started in LM Studio |
| Wrong model name | Check LM Studio → copy exact model ID to settings |
| Input not filled | WhatsApp may have updated their DOM — check console for errors |

---

## 📝 Notes
- The extension injects a suggestion panel — **you still manually press Enter** to send
- Chat history (last 8 messages) is sent to LM Studio for context
- Keywords are case-insensitive
- Edit the suggestion directly in the panel before sending
