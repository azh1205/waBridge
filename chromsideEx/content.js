// content.js — Injected into web.whatsapp.com
// Monitors chat messages, matches keywords, shows suggestion panel

console.log("[WA-LLM] Content script successfully loaded. Waiting for WhatsApp UI...");

let settings = { keywords: [], model: "local-model", systemPrompt: "" };
let lastProcessedSignature = null;
let suggestionPanel = null;
let isProcessing = false;

// ─── Extension health check ───────────────────────────────────────────────────

function isExtensionValid() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "PING" }, () => {
        resolve(!chrome.runtime.lastError);
      });
      setTimeout(() => resolve(false), 1000);
    } catch (e) {
      resolve(false);
    }
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function init() {
  console.log("[WA-LLM] Starting initialization sequence...");

  // Check extension is still alive before proceeding
  const alive = await isExtensionValid();
  if (!alive) {
    console.warn("[WA-LLM] Extension disconnected, reloading page...");
    window.location.reload();
    return;
  }

  try {
    settings = await getSettings();
    settings.keywords = normalizeKeywords(settings.keywords);
    console.log("[WA-LLM] Settings loaded.", settings);
  } catch (err) {
    console.error("[WA-LLM] Failed to load settings, using defaults.", err);
    settings = {
      keywords: ["help", "support", "info", "halo", "hai"],
      model: "local-model",
      systemPrompt: "",
    };
    settings.keywords = normalizeKeywords(settings.keywords);
  }

  injectPanel();
  observeChat();
  console.log("[WA-LLM] Extension active. Listening for keywords:", settings.keywords);
  console.log("[WA-LLM] Normalized keywords:", settings.keywords.join(", "));
}

function getSettings() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout waiting for background script")), 3000);

    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, (res) => {
      clearTimeout(timeout);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(res);
      }
    });
  });
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;

  if (changes.keywords) {
    settings.keywords = normalizeKeywords(changes.keywords.newValue);
  }
  if (changes.model) {
    settings.model = changes.model.newValue || "local-model";
  }
  if (changes.systemPrompt) {
    settings.systemPrompt = changes.systemPrompt.newValue || "";
  }

  console.log("[WA-LLM] Settings updated live:", settings);
});

// ─── DOM Observer ─────────────────────────────────────────────────────────────

function observeChat() {
  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    // Debounce: wait for DOM to settle before checking (WhatsApp mutates constantly)
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(checkLatestMessage, 300);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function checkLatestMessage() {
  if (isProcessing) return;

  const latestMessage = getLatestMessageNode();
  if (!latestMessage) return;

  processMessageNode(latestMessage);
}

function getLatestMessageNode() {
  const messageNodes = Array.from(
    document.querySelectorAll('[data-id], div[class*="message-in"], div[class*="message-out"]')
  );

  for (let i = messageNodes.length - 1; i >= 0; i -= 1) {
    const node = messageNodes[i];
    if (extractMessageText(node)) {
      return node;
    }
  }

  return null;
}

function processMessageNode(node) {
  // data-id may be on the node itself, a parent, or a child — walk all three before giving up
  const msgId =
    node.getAttribute("data-id") ||
    node.closest("[data-id]")?.getAttribute("data-id") ||
    node.querySelector("[data-id]")?.getAttribute("data-id");

  const messageText = extractMessageText(node);
  if (!messageText) return;

  const signature = `${msgId || "no-id"}::${messageText}`;
  if (signature === lastProcessedSignature) return;

  const direction = node.closest('[class*="message-out"]') ? "outgoing" : "incoming";
  console.log(`[WA-LLM] Captured ${direction} message: "${messageText.substring(0, 50)}"`);

  const matched = settings.keywords.some((kw) =>
    messageText.toLowerCase().includes(kw)
  );

  if (!matched) {
    console.log(`[WA-LLM] No keyword match. Keywords:`, settings.keywords);
    lastProcessedSignature = signature;
    return;
  }

  console.log(`[WA-LLM] Keyword matched! Triggering LLM...`);
  lastProcessedSignature = signature;
  handleKeywordMatch(messageText);
}

async function handleKeywordMatch(messageText) {
  isProcessing = true;
  showPanel("thinking");

  const chatHistory = collectChatHistory();
  const contactName = getContactName();

  chrome.runtime.sendMessage(
    {
      type: "GET_SUGGESTION",
      payload: {
        message: messageText,
        contactName,
        chatHistory,
        model: settings.model,
        systemPrompt: settings.systemPrompt,
      },
    },
    (response) => {
      if (chrome.runtime.lastError) {
        showPanel("error", chrome.runtime.lastError.message);
        isProcessing = false; // release lock AFTER panel update to block observer re-trigger
        return;
      }
      if (response?.ok) {
        showPanel("suggestion", response.reply);
      } else {
        showPanel("error", response?.error || "Unknown error");
      }
      isProcessing = false; // release lock AFTER panel update to block observer re-trigger
    }
  );
}

// ─── Chat Context Helpers ──────────────────────────────────────────────────────

function collectChatHistory() {
  const history = [];
  const messages = document.querySelectorAll('[data-id], div[class*="message-in"], div[class*="message-out"]');
  const recent = Array.from(messages).slice(-10);

  for (const el of recent) {
    const isOutgoing = el.closest('[class*="message-out"]') !== null;
    const text = extractMessageText(el);
    if (!text) continue;
    history.push({ role: isOutgoing ? "assistant" : "user", content: text });
  }

  return history;
}

function getContactName() {
  const header = document.querySelector(
    '[data-testid="conversation-header"] [data-testid="conversation-info-header-chat-title"]'
  );
  return header?.innerText?.trim() || "Contact";
}

// ─── Suggestion Panel UI ──────────────────────────────────────────────────────

function injectPanel() {
  if (suggestionPanel) return;

  suggestionPanel = document.createElement("div");
  suggestionPanel.id = "wa-llm-panel";
  suggestionPanel.innerHTML = `
    <div class="wa-llm-header">
      <span class="wa-llm-logo">⚡ LLM Assist</span>
      <button class="wa-llm-close" id="wa-llm-close">✕</button>
    </div>
    <div class="wa-llm-body" id="wa-llm-body">
      <div class="wa-llm-idle">Waiting for keyword match...</div>
    </div>
    <div class="wa-llm-footer" id="wa-llm-footer" style="display:none">
      <button class="wa-btn wa-btn-secondary" id="wa-llm-regen">↺ Regenerate</button>
      <button class="wa-btn wa-btn-primary" id="wa-llm-send">Send ↗</button>
    </div>
  `;

  document.body.appendChild(suggestionPanel);

  document.getElementById("wa-llm-close").addEventListener("click", () => {
    suggestionPanel.classList.add("wa-llm-hidden");
  });

  document.getElementById("wa-llm-send").addEventListener("click", sendSuggestion);
  document.getElementById("wa-llm-regen").addEventListener("click", regenerate);
}

let currentSuggestion = "";

function showPanel(state, content = "") {
  if (!suggestionPanel) injectPanel();
  suggestionPanel.classList.remove("wa-llm-hidden");

  const body = document.getElementById("wa-llm-body");
  const footer = document.getElementById("wa-llm-footer");

  if (state === "thinking") {
    body.innerHTML = `<div class="wa-llm-thinking"><span class="wa-dot"></span><span class="wa-dot"></span><span class="wa-dot"></span><span style="margin-left:8px">Generating reply...</span></div>`;
    footer.style.display = "none";
  } else if (state === "suggestion") {
    currentSuggestion = content;
    body.innerHTML = `<div class="wa-llm-suggestion" contenteditable="true" id="wa-llm-text">${escapeHtml(content)}</div>`;
    footer.style.display = "flex";
    // Note: Send/Regen listeners are already attached once in injectPanel() — don't re-add here
  } else if (state === "error") {
    body.innerHTML = `<div class="wa-llm-error">⚠ ${escapeHtml(content)}</div>`;
    footer.style.display = "none";
  }
}

function sendSuggestion() {
  const textEl = document.getElementById("wa-llm-text");
  const text = textEl ? textEl.innerText.trim() : currentSuggestion;
  if (!text) return;

  injectTextIntoInput(text);
  document.getElementById("wa-llm-footer").style.display = "none";
  document.getElementById("wa-llm-body").innerHTML = `<div class="wa-llm-idle">✓ Sent! Waiting for next keyword...</div>`;
}

function regenerate() {
  const latestMessage = getLatestMessageNode();
  const msg = latestMessage ? extractMessageText(latestMessage) : "";
  if (msg) handleKeywordMatch(msg);
}

// ─── WhatsApp Input Injection ─────────────────────────────────────────────────

function injectTextIntoInput(text) {
  const input =
    document.querySelector('[data-testid="conversation-compose-box-input"]') ||
    document.querySelector('div[contenteditable="true"][data-tab="10"]') ||
    document.querySelector('div[contenteditable="true"][role="textbox"]');

  if (!input) {
    console.error("[WA-LLM] Could not find message input box");
    return;
  }

  input.focus();
  document.execCommand("selectAll", false, null);
  document.execCommand("insertText", false, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "<br>");
}

function normalizeKeywords(keywords) {
  return (Array.isArray(keywords) ? keywords : [])
    .map((kw) => String(kw).trim().toLowerCase())
    .filter(Boolean);
}

function extractMessageText(node) {
  if (!node) return "";

  const selectors = [
    "span.selectable-text",
    "div.copyable-text span[dir='ltr']",
    "div.copyable-text span[dir='auto']",
    '[data-testid="msg-text"]',
    '[data-testid="conversation-text-message"]'
  ];

  for (const selector of selectors) {
    const candidates = Array.from(node.querySelectorAll(selector));
    const text = candidates.map((el) => el.innerText?.trim() || "").filter(Boolean).join(" ").trim();
    if (text) return text;
  }

  const copyable = node.querySelector("div.copyable-text");
  if (copyable?.innerText?.trim()) {
    return copyable.innerText.trim();
  }

  if (node.innerText?.trim() && node.innerText.trim().length < 2000) {
    return node.innerText.trim();
  }

  return "";
}

// ─── Start ────────────────────────────────────────────────────────────────────

let attempts = 0;
const bootInterval = setInterval(() => {
  attempts++;

  const isLoaded =
    document.getElementById("pane-side") ||
    document.querySelector("#app .two") ||
    // Modern WhatsApp Web selectors (updated from stale title attribute)
    document.querySelector('[data-testid="chat-list"]') ||
    document.querySelector('[data-testid="search-input-container"]') ||
    document.querySelector('div[contenteditable="true"][data-tab="3"]');

  if (isLoaded) {
    console.log("[WA-LLM] WhatsApp UI detected!");
    clearInterval(bootInterval);
    init();
  } else if (attempts > 30) {
    clearInterval(bootInterval);
    console.error("[WA-LLM] Gave up waiting for WhatsApp UI.");
  } else if (attempts % 5 === 0) {
    console.log(`[WA-LLM] Waiting for WhatsApp to load... (attempt ${attempts})`);
  }
}, 2000);
