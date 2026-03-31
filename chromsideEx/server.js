// server.js — MCP Bridge Server
// Connects Chrome Extension ↔ LM Studio local LLM
// Exposes a simple REST API that the extension calls

import express from "express";
import cors from "cors";
import fetch from "node-fetch";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = 3000;
const LM_STUDIO_URL = process.env.LM_STUDIO_URL || "http://localhost:1234";
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "local-model";
const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful WhatsApp assistant. Reply concisely, naturally, and match the tone of the conversation. Keep replies under 3 sentences unless more detail is clearly needed.";

// ─── Express Setup ────────────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check — extension popup polls this
app.get("/health", async (req, res) => {
  try {
    const models = await fetchModels();
    res.json({ status: "ok", model: models[0]?.id || DEFAULT_MODEL, models });
  } catch (err) {
    res.status(503).json({ status: "error", error: err.message });
  }
});

// List available models from LM Studio
app.get("/models", async (req, res) => {
  try {
    const models = await fetchModels();
    res.json({ models });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Main suggestion endpoint — called by extension background.js
app.post("/suggest", async (req, res) => {
  const {
    message,
    contactName = "Contact",
    chatHistory = [],
    model = DEFAULT_MODEL,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
  } = req.body;

  if (!message) {
    return res.status(400).json({ error: "message is required" });
  }

  console.log(`[MCP] Suggest request from "${contactName}": "${message.slice(0, 60)}..."`);

  try {
    const reply = await generateReply({ message, contactName, chatHistory, model, systemPrompt });
    console.log(`[MCP] Reply: "${reply.slice(0, 80)}..."`);
    res.json({ reply });
  } catch (err) {
    console.error("[MCP] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// MCP-style tool call endpoint (for future MCP client compatibility)
app.post("/mcp", async (req, res) => {
  const { method, params } = req.body;

  if (method === "tools/list") {
    return res.json({
      tools: [
        {
          name: "whatsapp_suggest_reply",
          description: "Generate a reply suggestion for a WhatsApp message",
          inputSchema: {
            type: "object",
            properties: {
              message: { type: "string", description: "The incoming message to reply to" },
              contactName: { type: "string", description: "Name of the contact" },
              chatHistory: { type: "array", description: "Recent chat history" },
            },
            required: ["message"],
          },
        },
      ],
    });
  }

  if (method === "tools/call" && params?.name === "whatsapp_suggest_reply") {
    try {
      const reply = await generateReply(params.arguments);
      return res.json({ content: [{ type: "text", text: reply }] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(404).json({ error: `Unknown method: ${method}` });
});

// ─── LM Studio Integration ────────────────────────────────────────────────────

async function fetchModels() {
  const res = await fetch(`${LM_STUDIO_URL}/v1/models`);
  if (!res.ok) throw new Error(`LM Studio unreachable at ${LM_STUDIO_URL}`);
  const data = await res.json();
  return data.data || [];
}

async function generateReply({ message, contactName, chatHistory = [], model, systemPrompt }) {
  // Build message array — include chat history for context
  const messages = [
    {
      role: "system",
      content: `${systemPrompt || DEFAULT_SYSTEM_PROMPT}\n\nYou are replying on behalf of the user in a WhatsApp conversation with ${contactName}.`,
    },
    ...chatHistory.slice(-8), // last 8 messages for context window efficiency
    {
      role: "user",
      content: `The latest message from ${contactName}: "${message}"\n\nWrite a suitable reply:`,
    },
  ];

  const res = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      messages,
      max_tokens: 300,
      temperature: 0.7,
      stream: false,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LM Studio error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content?.trim();

  if (!reply) throw new Error("Empty response from LM Studio");
  return reply;
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║     WhatsApp LLM MCP Bridge Server           ║
╠══════════════════════════════════════════════╣
║  Running on  : http://localhost:${PORT}          ║
║  LM Studio   : ${LM_STUDIO_URL}   ║
║  Model       : ${DEFAULT_MODEL.padEnd(14)}            ║
╠══════════════════════════════════════════════╣
║  Endpoints:                                  ║
║   GET  /health    → server + model status    ║
║   GET  /models    → list LM Studio models    ║
║   POST /suggest   → generate reply           ║
║   POST /mcp       → MCP tool protocol        ║
╚══════════════════════════════════════════════╝
  `);
});
