// server.js — WhatsApp LLM Bridge Server (UPDATED)
// Uses LM Studio's /api/v1/chat with MCP plugins — no manual MCP spawning needed
// Extension → Bridge (port 3000) → LM Studio (port 1234) + MCP plugins

import express from "express";
import cors from "cors";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const LM_URL = process.env.LM_STUDIO_URL || "http://localhost:1234";
const LM_API_KEY = process.env.LM_API_KEY || "";
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "phi-3.1-mini-4k-instruct";

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful WhatsApp assistant. " +
  "Reply concisely and naturally — this is a WhatsApp message, not an essay. " +
  "Reply in the same language the user is writing in.";

// Must match the server keys in your mcp.json exactly
const MCP_PLUGINS = [
  "mcp/file-reader",
  "mcp/web-summarizer",
  "mcp/github-reader",
  "mcp/memory-mcp",
];

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check — polled by extension popup
app.get("/health", async (req, res) => {
  try {
    const r = await lmFetch("GET", "/api/v1/models");
    const models = r.data?.map((m) => m.id) || [];
    res.json({ status: "ok", lmStudio: "online", model: models[0] || DEFAULT_MODEL, models });
  } catch (err) {
    res.json({ status: "ok", lmStudio: "offline", error: err.message });
  }
});

// Status — open in browser to verify setup
app.get("/status", (_req, res) => {
  res.json({
    bridge: "running",
    port: PORT,
    lmStudio: LM_URL,
    endpoint: `${LM_URL}/v1/chat/completions`,
    mcpPlugins: "disabled",
    defaultModel: DEFAULT_MODEL,
  });
});

// Main endpoint — called by Chrome extension background.js
app.post("/suggest", async (req, res) => {
  const {
    message,
    contactName = "Contact",
    chatHistory = [],
    model = DEFAULT_MODEL,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
  } = req.body;

  if (!message) return res.status(400).json({ error: "message is required" });

  console.log(`\n[Bridge] ── Incoming ──────────────────────────`);
  console.log(`[Bridge] Contact : ${contactName}`);
  console.log(`[Bridge] Message : "${message.slice(0, 80)}"`);

  try {
    const reply = await generateReply({ message, contactName, chatHistory, model, systemPrompt });
    console.log(`[Bridge] Reply   : "${reply.slice(0, 100)}"`);
    res.json({ reply });
  } catch (err) {
    console.error("[Bridge] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║     WhatsApp LLM Bridge — Running            ║
╠══════════════════════════════════════════════╣
║  Bridge   : http://localhost:${PORT}              ║
║  LM Studio: ${LM_URL}
║  Endpoint : /v1/chat/completions             ║
║  MCP      : disabled (direct LLM mode)       ║
╚══════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on("SIGINT", () => process.exit(0));

// ─── Core: Generate Reply via LM Studio ──────────────────────────────────────

async function generateReply({ message, contactName, chatHistory, model, systemPrompt }) {

  // Build input string with recent chat context
  const historyText = chatHistory.slice(-6)
    .map((m) => `${m.role === "assistant" ? "Me" : contactName}: ${m.content}`)
    .join("\n");

  const input = [
    historyText,
    `${contactName}: ${message}`,
    `\nWrite a natural, brief WhatsApp reply on my behalf.`,
  ].filter(Boolean).join("\n");

  // Build standard OpenAI-compatible chat payload (no MCP plugins needed)
  const payload = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: input },
    ],
    temperature: 0.7,
    max_tokens: 512,
    stream: false,
  };

  console.log(`[Bridge] → POST ${LM_URL}/v1/chat/completions (model: ${model})`);

  const data = await lmFetch("POST", "/v1/chat/completions", payload);

  // LM Studio /api/v1/chat response shapes:
  const reply =
    data.output?.trim() ||
    data.choices?.[0]?.message?.content?.trim() ||
    data.choices?.[0]?.text?.trim() ||
    data.response?.trim() ||
    data.content?.trim();

  if (!reply) {
    console.error("[Bridge] Unexpected response:", JSON.stringify(data).slice(0, 400));
    throw new Error("No reply text from LM Studio. Check model name + server logs.");
  }

  return reply;
}

// ─── LM Studio HTTP Helper ────────────────────────────────────────────────────

async function lmFetch(method, path, body = null) {
  const url = `${LM_URL}${path}`;
  const headers = { "Content-Type": "application/json" };
  if (LM_API_KEY) headers["Authorization"] = `Bearer ${LM_API_KEY}`;

  const res = await fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LM Studio ${res.status}: ${text.slice(0, 300)}`);
  }

  return res.json();
}
