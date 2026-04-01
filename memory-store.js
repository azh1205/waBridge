// memory-store.js
// Per-contact memory — stored in contacts.json, NO LLM extraction
// Memory is built manually via the Write button in the extension panel
// Only a short summary is injected into LLM context to preserve VRAM

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = path.join(__dirname, "contacts.json");

// ─── File I/O ─────────────────────────────────────────────────────────────────

function load() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
    }
  } catch (err) {
    console.warn("[Memory] Failed to load contacts.json:", err.message);
  }
  return {};
}

function save(data) {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("[Memory] Failed to save contacts.json:", err.message);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function getContact(name) {
  return load()[name] || null;
}

export function getAllContacts() {
  return load();
}

export function upsertContact(name, fields) {
  const db = load();
  const existing = db[name] || {
    name,
    style: "",
    topics: [],
    notes: "",
    messageCount: 0,
    lastSeen: null,
    updatedAt: null,
  };

  db[name] = {
    ...existing,
    ...fields,
    name,
    updatedAt: new Date().toISOString(),
  };

  save(db);
  return db[name];
}

export function deleteContact(name) {
  const db = load();
  if (!db[name]) return false;
  delete db[name];
  save(db);
  return true;
}

// ─── Called after each message — just tracks count + lastSeen ────────────────
// No LLM call, no extraction — keeps things fast and VRAM-friendly

export function trackMessage(contactName) {
  const existing = getContact(contactName);
  upsertContact(contactName, {
    messageCount: (existing?.messageCount || 0) + 1,
    lastSeen: new Date().toISOString(),
  });
}

// ─── Format for display in extension panel ────────────────────────────────────

export function formatMemory(contact) {
  if (!contact) return null;
  return {
    name: contact.name,
    style: contact.style || "",
    topics: contact.topics || [],
    notes: contact.notes || "",
    messageCount: contact.messageCount || 0,
    lastSeen: contact.lastSeen
      ? new Date(contact.lastSeen).toLocaleString()
      : "Never",
  };
}

// ─── Build a SHORT context string injected into LLM system prompt ─────────────
// Kept under ~50 tokens to not waste context window

export function buildMemoryContext(contactName) {
  const c = getContact(contactName);
  if (!c) return "";

  const parts = [];
  if (c.style)          parts.push(`Style: ${c.style}`);
  if (c.topics?.length) parts.push(`Topics: ${c.topics.slice(0, 3).join(", ")}`);
  if (c.notes)          parts.push(`Notes: ${c.notes}`);

  if (!parts.length) return "";
  return `About ${contactName}:\n${parts.join("\n")}`;
}
