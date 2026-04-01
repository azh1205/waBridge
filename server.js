// server.js — WhatsApp LLM Bridge Server
// Memory: stored in contacts.json, NO LLM extraction — manual only

import express from "express";
import cors from "cors";
import { McpManager } from "./mcp-manager.js";
import {
  getContact,
  getAllContacts,
  upsertContact,
  deleteContact,
  trackMessage,
  formatMemory,
} from "./memory-store.js";
import { deleteImageContext, getImageContext, upsertImageContext } from "./image-context-store.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT          = process.env.PORT          || 3000;
const LM_URL        = process.env.LM_STUDIO_URL  || "http://localhost:1234";
const LM_API_KEY    = process.env.LM_API_KEY     || "";
const DEFAULT_MODEL = process.env.DEFAULT_MODEL  || "local-model";
const MAX_TOOL_ROUNDS = 5;
const ENABLE_MCP_TOOLS = String(process.env.ENABLE_MCP_TOOLS || "false").toLowerCase() === "true";

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful WhatsApp assistant. " +
  "Reply concisely and naturally — this is a WhatsApp message, not an essay. " +
  "Reply in the same language the user is writing in.";

// ─── Boot ─────────────────────────────────────────────────────────────────────

const mcpManager = new McpManager();
const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "12mb" }));

console.log("\n╔══════════════════════════════════════════════╗");
console.log("║     WhatsApp LLM Bridge — Starting Up        ║");
console.log("╚══════════════════════════════════════════════╝\n");

await mcpManager.start();

// ─── Routes: Core ─────────────────────────────────────────────────────────────

app.get("/health", async (_req, res) => {
  let lmStatus = "offline";
  let models = [];
  try {
    const r = await lmFetch("GET", "/v1/models");
    models = r.data?.map((m) => m.id) || [];
    lmStatus = "online";
  } catch {}
  res.json({ status: "ok", lmStudio: lmStatus, model: models[0] || DEFAULT_MODEL, models, mcp: mcpManager.status() });
});

app.get("/status", (_req, res) => {
  res.json({
    bridge: "running", port: PORT, lmStudio: LM_URL,
    mcpServers: mcpManager.status(),
    availableTools: mcpManager.getToolsForLLM().map((t) => t.function.name),
    contacts: Object.keys(getAllContacts()).length,
  });
});

// Main suggest endpoint
app.post("/suggest", async (req, res) => {
  const {
    message,
    contactName  = "Contact",
    chatHistory  = [],
    model        = DEFAULT_MODEL,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    useTools,
    imageDataUrl,
    latestImageKey,
    forceImageRefresh,
  } = req.body;

  if (!message) return res.status(400).json({ error: "message is required" });

  console.log(`\n[Bridge] Contact: ${contactName} | Message: "${message.slice(0, 60)}"`);

  try {
    const imageContextSummary = await resolveImageContext({
      contactName,
      latestImageKey,
      imageDataUrl,
      model,
      forceImageRefresh,
    });

    const reply = await generateReply({
      message,
      contactName,
      chatHistory,
      model,
      systemPrompt,
      useTools,
      imageDataUrl,
      imageContextSummary,
    });

    // Just track message count + lastSeen — no LLM extraction
    trackMessage(contactName);

    console.log(`[Bridge] Reply: "${reply.slice(0, 80)}"`);
    res.json({ reply });
  } catch (err) {
    console.error("[Bridge] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Routes: Memory ───────────────────────────────────────────────────────────

// List all contacts
app.get("/memory", (_req, res) => {
  const all = getAllContacts();
  const summary = Object.values(all).map((c) => ({
    name: c.name,
    messageCount: c.messageCount || 0,
    lastSeen: c.lastSeen,
    topicsCount: c.topics?.length || 0,
  }));
  res.json({ contacts: summary });
});

// Get one contact
app.get("/memory/:name", (req, res) => {
  const contact = getContact(req.params.name);
  if (!contact) return res.status(404).json({ error: `No memory for "${req.params.name}"` });
  res.json({ contact: formatMemory(contact) });
});

// Manual write/update
app.put("/memory/:name", (req, res) => {
  const { style, topics, notes } = req.body;
  const updated = upsertContact(req.params.name, {
    ...(style  !== undefined && { style }),
    ...(topics !== undefined && { topics: Array.isArray(topics) ? topics : [topics] }),
    ...(notes  !== undefined && { notes }),
  });
  console.log(`[Memory] Manual write for "${req.params.name}"`);
  res.json({ contact: formatMemory(updated) });
});

// Delete contact memory
app.delete("/memory/:name", (req, res) => {
  const deleted = deleteContact(req.params.name);
  if (!deleted) return res.status(404).json({ error: "Contact not found" });
  res.json({ ok: true, deleted: req.params.name });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.delete("/image-context/:name", (req, res) => {
  deleteImageContext(req.params.name);
  res.json({ ok: true, cleared: req.params.name });
});

app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  Bridge   : http://localhost:${PORT}              ║`);
  console.log(`║  LM Studio: ${LM_URL.padEnd(34)}║`);
  console.log(`║  Tools    : ${String(mcpManager.allTools.length).padEnd(38)}║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);
});

app.use((err, _req, res, next) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({
      error: "Image payload too large. Try a smaller image or crop the visible photo before analyzing.",
    });
  }
  return next(err);
});

process.on("SIGINT", () => { mcpManager.stopAll(); process.exit(0); });

// ─── Agentic Loop ─────────────────────────────────────────────────────────────

async function generateWithTools({ message, contactName, chatHistory, model, systemPrompt }) {
  const tools = mcpManager.getToolsForLLM();
  const messages = [
    { role: "system", content: `${systemPrompt}\n\nYou are replying on behalf of the user in a WhatsApp conversation with ${contactName}.` },
    ...chatHistory.slice(-8),
    { role: "user", content: `New message from ${contactName}: "${message}"\n\nGenerate a suitable WhatsApp reply.` },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await lmFetch("POST", "/v1/chat/completions", {
      model, messages, max_tokens: 1000, temperature: 0.7,
      ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    });

    const choice = response.choices?.[0];
    if (!choice) throw new Error("No response from LM Studio");

    const { finish_reason, message: assistantMsg } = choice;
    messages.push(assistantMsg);

    if (finish_reason === "stop" || finish_reason === "length") {
      const text = assistantMsg.content?.trim();
      if (text) return text;
    }

    const toolCalls = assistantMsg.tool_calls;
    if (!toolCalls?.length) return assistantMsg.content?.trim() || "Sorry, I couldn't generate a reply.";

    for (const call of toolCalls) {
      let toolArgs = {};
      try { toolArgs = JSON.parse(call.function.arguments || "{}"); } catch {}
      let toolResult;
      try { toolResult = await mcpManager.executeTool(call.function.name, toolArgs); }
      catch (err) { toolResult = `Tool error: ${err.message}`; }
      messages.push({ role: "tool", tool_call_id: call.id, content: String(toolResult) });
    }
  }

  const fallback = await lmFetch("POST", "/v1/chat/completions", {
    model, max_tokens: 500, temperature: 0.7,
    messages: [...messages, { role: "user", content: "Give your final WhatsApp reply now." }],
  });
  return fallback.choices?.[0]?.message?.content?.trim() || "Sorry, I couldn't generate a reply.";
}

async function generateReply({ message, contactName, chatHistory, model, systemPrompt, useTools, imageDataUrl, imageContextSummary }) {
  const shouldUseMcpTools = !imageDataUrl && shouldUseTools({ model, useTools });

  const primaryReply = shouldUseMcpTools
    ? await generateWithTools({ message, contactName, chatHistory, model, systemPrompt })
    : await generatePlainReply({ message, contactName, chatHistory, model, systemPrompt, imageDataUrl, imageContextSummary });

  if (!looksLikeGibberish(primaryReply)) {
    return primaryReply;
  }

  console.warn(`[Bridge] Detected low-quality model output from "${model}". Retrying with minimal prompt.`);
  const fallbackReply = await generatePlainReply({
    message,
    contactName,
    chatHistory: [],
    model,
    systemPrompt,
    imageDataUrl,
    imageContextSummary,
  });

  return fallbackReply;
}

async function generatePlainReply({ message, contactName, chatHistory, model, systemPrompt, imageDataUrl, imageContextSummary }) {
  const latestUserPrompt = imageDataUrl
    ? [
        {
          type: "text",
          text:
            `Latest context from ${contactName}: "${message}"\n\n` +
            `Analyze the attached WhatsApp image and write one clear reply the user could send back. ` +
            `If the image does not need a reply, briefly describe it and suggest a useful response anyway. ` +
            `Do not explain your reasoning.`,
        },
        {
          type: "image_url",
          image_url: {
            url: imageDataUrl,
          },
        },
      ]
    : buildTextOnlyPrompt({ message, contactName, imageContextSummary });

  const messages = [
    {
      role: "system",
      content:
        `${systemPrompt}\n\n` +
        `You are replying on behalf of the user in a WhatsApp conversation with ${contactName}. ` +
        `Write only the final reply text. Keep it natural, short, and coherent.`,
    },
    ...chatHistory.slice(imageDataUrl ? -2 : -4),
    {
      role: "user",
      content: latestUserPrompt,
    },
  ];

  const response = await lmFetch("POST", "/v1/chat/completions", {
    model,
    messages,
    max_tokens: 160,
    temperature: 0.5,
  });

  const text = response.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Empty response from LM Studio");
  return text;
}

async function resolveImageContext({ contactName, latestImageKey, imageDataUrl, model, forceImageRefresh }) {
  if (!latestImageKey) return "";

  const cached = getImageContext(contactName);
  const cacheMatches = cached?.imageKey === latestImageKey;

  if (cacheMatches && !forceImageRefresh) {
    return cached.summary || "";
  }

  if (!imageDataUrl) {
    return "";
  }

  const summary = await generateImageSummary({ contactName, imageDataUrl, model });
  upsertImageContext(contactName, {
    imageKey: latestImageKey,
    summary,
  });
  return summary;
}

async function generateImageSummary({ contactName, imageDataUrl, model }) {
  const response = await lmFetch("POST", "/v1/chat/completions", {
    model,
    messages: [
      {
        role: "system",
        content:
          "Summarize the attached WhatsApp image for future reply context. " +
          "Return a short factual summary under 80 words. Focus on what matters for follow-up chat replies.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Create a compact image context summary for the chat with ${contactName}.`,
          },
          {
            type: "image_url",
            image_url: {
              url: imageDataUrl,
            },
          },
        ],
      },
    ],
    max_tokens: 120,
    temperature: 0.2,
  });

  const summary = response.choices?.[0]?.message?.content?.trim();
  if (!summary) {
    throw new Error("Empty image summary from LM Studio");
  }
  return summary;
}

function buildTextOnlyPrompt({ message, contactName, imageContextSummary }) {
  let prompt = `Latest message from ${contactName}: "${message}"\n\n`;
  if (imageContextSummary) {
    prompt += `Relevant image context from this chat: ${imageContextSummary}\n\n`;
  }
  prompt += "Write one clear WhatsApp reply. Do not explain your reasoning.";
  return prompt;
}

function shouldUseTools({ model, useTools }) {
  if (typeof useTools === "boolean") return useTools;
  if (!ENABLE_MCP_TOOLS) return false;

  const lowerModel = String(model || "").toLowerCase();
  const knownSmallModels = ["phi-3", "mini", "3b", "1b", "2b", "4k"];
  return !knownSmallModels.some((token) => lowerModel.includes(token));
}

function looksLikeGibberish(text) {
  if (!text) return true;

  const trimmed = text.trim();
  if (trimmed.length < 2) return true;

  const weirdPunctuation = (trimmed.match(/[{}\[\]\\/_]{6,}|["',]\s*["',]/g) || []).length;
  const repeatedFragments = (trimmed.match(/\b(description|required|type|properties|schema|input)\b/gi) || []).length;
  const alphaChars = (trimmed.match(/[A-Za-z]/g) || []).length;
  const spaceChars = (trimmed.match(/\s/g) || []).length;
  const punctuationChars = (trimmed.match(/[^\w\s]/g) || []).length;

  if (repeatedFragments >= 3) return true;
  if (weirdPunctuation >= 2) return true;
  if (alphaChars > 0 && punctuationChars > alphaChars) return true;
  if (trimmed.length > 80 && spaceChars < 6) return true;

  return false;
}

// ─── LM Studio HTTP Helper ────────────────────────────────────────────────────

async function lmFetch(method, path, body = null) {
  const url = `${LM_URL}${path}`;
  const headers = { "Content-Type": "application/json" };
  if (LM_API_KEY) headers["Authorization"] = `Bearer ${LM_API_KEY}`;
  const res = await fetch(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LM Studio ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}
