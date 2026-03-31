// content.js — Injected into web.whatsapp.com
// Monitors incoming messages, matches keywords, shows suggestion panel

let settings = { keywords: [], model: "local-model", systemPrompt: "" };
let lastProcessedMsgId = null;
let suggestionPanel = null;
let isProcessing = false;

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function init() {
  settings = await getSettings();
  injectPanel();
  observeChat();
  console.log("[WA-LLM] Extension active. Keywords:", settings.keywords);
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_SETTINGS" }, resolve);
  });
}

// ─── DOM Observer ─────────────────────────────────────────────────────────────

function observeChat() {
  const observer = new MutationObserver(() => {
    checkLatestMessage();
  });

  // Watch for new chat messages
  const targetNode = document.body;
  observer.observe(targetNode, { childList: true, subtree: true });
}

function checkLatestMessage() {
  if (isProcessing) return;

  // WhatsApp Web: incoming messages have data-id and no "out" class
  const allMessages = document.querySelectorAll('[data-id]');
  if (!allMessages.length) return;

  // Find the last incoming message
  let lastIncoming = null;
  for (const el of allMessages) {
    const isOutgoing = el.closest('[class*="message-out"]') !== null;
    if (!isOutgoing) lastIncoming = el;
  }

  if (!lastIncoming) return;

  const msgId = lastIncoming.getAttribute("data-id");
  if (msgId === lastProcessedMsgId) return;

  // Get text content
  const textEl = lastIncoming.querySelector("span.selectable-text");
  if (!textEl) return;

  const messageText = textEl.innerText?.trim();
  if (!messageText) return;

  // Check if any keyword matches
  const matched = settings.keywords.some((kw) =>
    messageText.toLowerCase().includes(kw.toLowerCase())
  );

  if (!matched) return;

  lastProcessedMsgId = msgId;
  handleKeywordMatch(messageText);
}

async function handleKeywordMatch(messageText) {
  isProcessing = true;
  showPanel("thinking");

  // Collect last few messages as chat history
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
      isProcessing = false;
      if (response?.ok) {
        showPanel("suggestion", response.reply);
      } else {
        showPanel("error", response?.error || "Unknown error");
      }
    }
  );
}

// ─── Chat Context Helpers ──────────────────────────────────────────────────────

function collectChatHistory() {
  const history = [];
  const messages = document.querySelectorAll('[data-id]');
  const recent = Array.from(messages).slice(-10); // last 10 messages

  for (const el of recent) {
    const isOutgoing = el.closest('[class*="message-out"]') !== null;
    const textEl = el.querySelector("span.selectable-text");
    if (!textEl) continue;
    const text = textEl.innerText?.trim();
    if (!text) continue;
    history.push({ role: isOutgoing ? "assistant" : "user", content: text });
  }

  return history;
}

function getContactName() {
  const header = document.querySelector('[data-testid="conversation-header"] [data-testid="conversation-info-header-chat-title"]');
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

  document.getElementById("wa-llm-send")?.addEventListener("click", sendSuggestion);
  document.getElementById("wa-llm-regen")?.addEventListener("click", regenerate);
}

let currentSuggestion = "";
let lastMessage = "";

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
    // Re-bind send since DOM was replaced
    document.getElementById("wa-llm-send").addEventListener("click", sendSuggestion);
    document.getElementById("wa-llm-regen").addEventListener("click", regenerate);
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
  showPanel("idle");
  document.getElementById("wa-llm-footer").style.display = "none";
  document.getElementById("wa-llm-body").innerHTML = `<div class="wa-llm-idle">✓ Sent! Waiting for next keyword...</div>`;
}

function regenerate() {
  if (!lastProcessedMsgId) return;
  const textEl = document.querySelector(`[data-id="${lastProcessedMsgId}"] span.selectable-text`);
  const msg = textEl?.innerText?.trim();
  if (msg) handleKeywordMatch(msg);
}

// ─── WhatsApp Input Injection ─────────────────────────────────────────────────

function injectTextIntoInput(text) {
  // Find the main message input box
  const input = document.querySelector('[data-testid="conversation-compose-box-input"]') ||
                document.querySelector('div[contenteditable="true"][data-tab="10"]') ||
                document.querySelector('div[contenteditable="true"][role="textbox"]');

  if (!input) {
    console.error("[WA-LLM] Could not find message input box");
    return;
  }

  input.focus();

  // Use execCommand to properly trigger React's synthetic event system
  document.execCommand("selectAll", false, null);
  document.execCommand("insertText", false, text);

  // Dispatch input event to make sure React state updates
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

// ─── Start ────────────────────────────────────────────────────────────────────

// Wait for WhatsApp to fully load
const bootInterval = setInterval(() => {
  if (document.querySelector('[data-testid="default-user"]') ||
      document.querySelector('[data-testid="chat-list"]') ||
      document.querySelector('[data-testid="side"]')) {
    clearInterval(bootInterval);
    init();
  }
}, 1500);
