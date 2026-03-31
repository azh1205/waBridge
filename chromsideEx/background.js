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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
    chrome.storage.sync.get(["keywords", "model", "systemPrompt"], (data) => {
      sendResponse({
        keywords: data.keywords || ["help", "support", "info", "halo", "hai"],
        model: data.model || "local-model",
        systemPrompt: data.systemPrompt || "You are a helpful WhatsApp assistant. Reply concisely and naturally.",
      });
    });
    return true;
  }

  if (msg.type === "SAVE_SETTINGS") {
    chrome.storage.sync.set(msg.payload, () => sendResponse({ ok: true }));
    return true;
  }
});

async function fetchSuggestion({ message, contactName, chatHistory, model, systemPrompt }) {
  const response = await fetch(`${MCP_SERVER}/suggest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, contactName, chatHistory, model, systemPrompt }),
  });

  if (!response.ok) {
    throw new Error(`MCP server error: ${response.status}`);
  }

  const data = await response.json();
  return data.reply;

}
