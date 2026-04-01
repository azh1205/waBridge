// popup.js
const MCP_SERVER = "http://localhost:3000";

async function checkServer() {
  const dot = document.getElementById("server-dot");
  const label = document.getElementById("server-label");
  try {
    const res = await fetch(`${MCP_SERVER}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      dot.className = "dot online";
      const data = await res.json();
      label.textContent = `Online — ${data.model || "model ready"}`;
    } else {
      throw new Error("not ok");
    }
  } catch {
    dot.className = "dot offline";
    label.textContent = "Offline — start mcp-server first";
  }
}

// Load saved settings
chrome.storage.sync.get(["keywords", "model", "systemPrompt", "autoSend", "autoSendDelay"], (data) => {
  document.getElementById("keywords").value = (data.keywords || ["help","support","info","halo","hai"]).join(", ");
  document.getElementById("model").value = data.model || "local-model";
  document.getElementById("systemPrompt").value = data.systemPrompt || "You are a helpful WhatsApp assistant. Reply concisely and naturally.";
  document.getElementById("autoSend").checked = data.autoSend || false;
  document.getElementById("autoSendDelay").value = data.autoSendDelay || 5;
});

// Save settings
document.getElementById("save").addEventListener("click", () => {
  const keywordsRaw = document.getElementById("keywords").value;
  const keywords = keywordsRaw.split(",").map((k) => k.trim()).filter(Boolean);
  const model = document.getElementById("model").value.trim();
  const systemPrompt = document.getElementById("systemPrompt").value.trim();
  const autoSend = document.getElementById("autoSend").checked;
  const autoSendDelay = parseInt(document.getElementById("autoSendDelay").value, 10) || 5;

  chrome.storage.sync.set({ keywords, model, systemPrompt, autoSend, autoSendDelay }, () => {
    const status = document.getElementById("status");
    status.textContent = "✓ Settings saved!";
    status.className = "status ok";
    setTimeout(() => { status.className = "status"; }, 2000);
  });
});

checkServer();
