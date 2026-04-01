// background.js — Service Worker
// Handles communication between content script and MCP bridge server

chrome.runtime.onStartup.addListener(() => {
  console.log("waBridge starting up");
  setupKeepAlive();
});

chrome.runtime.onInstalled.addListener(() => {
  setupKeepAlive();
});

// Use chrome.alarms to keep the service worker alive (setInterval doesn't work in MV3)
function setupKeepAlive() {
  chrome.alarms.create("keepAlive", { periodInMinutes: 0.4 }); // every ~24s
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    console.log("[waBridge] Service worker keep-alive ping");
  }
});

const MCP_SERVER = "http://localhost:3000";
const SUGGESTION_TIMEOUT_MS = 12000;
const SUGGESTION_RETRY_COUNT = 1;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("[waBridge] Background message received:", msg?.type, {
    tabId: sender?.tab?.id,
    contactName: msg?.payload?.contactName,
  });
  // Health check from content.js — must respond or the page will reload
  if (msg.type === "PING") {
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "GET_SUGGESTION") {
    fetchSuggestion(msg.payload)
      .then((reply) => sendResponse({ ok: true, reply }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async
  }

  if (msg.type === "GET_SETTINGS") {
    chrome.storage.sync.get(["keywords", "model", "systemPrompt", "autoSend", "autoSendDelay"], (data) => {
      sendResponse({
        keywords: data.keywords || ["help", "support", "info", "halo", "hai"],
        model: data.model || "local-model",
        systemPrompt: data.systemPrompt || "You are a helpful WhatsApp assistant. Reply concisely and naturally.",
        autoSend: data.autoSend || false,
        autoSendDelay: data.autoSendDelay || 5,
      });
    });
    return true;
  }

  if (msg.type === "SAVE_SETTINGS") {
    chrome.storage.sync.set(msg.payload, () => sendResponse({ ok: true }));
    return true;
  }
});

async function fetchSuggestion(payload) {
  const requestBody = JSON.stringify(payload);
  let lastError = null;

  for (let attempt = 0; attempt <= SUGGESTION_RETRY_COUNT; attempt++) {
    const attemptNumber = attempt + 1;

    try {
      console.log("[waBridge] Fetching suggestion", {
        attempt: attemptNumber,
        contactName: payload.contactName,
        historyLength: Array.isArray(payload.chatHistory) ? payload.chatHistory.length : 0,
      });

      const response = await fetchWithTimeout(
        `${MCP_SERVER}/suggest`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
        },
        SUGGESTION_TIMEOUT_MS
      );

      if (!response.ok) {
        throw new Error(`MCP server error: ${response.status}`);
      }

      const data = await response.json();
      console.log("[waBridge] Suggestion fetch succeeded", {
        attempt: attemptNumber,
        contactName: payload.contactName,
      });
      return data.reply;
    } catch (error) {
      lastError = error;

      if (attempt === SUGGESTION_RETRY_COUNT || !isRetryableError(error)) {
        break;
      }
    }
  }

  throw new Error(getFriendlySuggestionError(lastError));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function isRetryableError(error) {
  const message = String(error?.message || "").toLowerCase();
  return error?.name === "AbortError" || message.includes("failed to fetch");
}

function getFriendlySuggestionError(error) {
  if (!error) return "Server not reachable";

  if (error.name === "AbortError") {
    return "Server not reachable";
  }

  const message = String(error.message || "");
  if (/failed to fetch/i.test(message)) {
    return "Server not reachable";
  }

  return message;
}
