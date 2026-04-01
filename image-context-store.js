import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGE_CONTEXT_FILE = path.join(__dirname, "image-contexts.json");

function loadStore() {
  try {
    if (fs.existsSync(IMAGE_CONTEXT_FILE)) {
      return JSON.parse(fs.readFileSync(IMAGE_CONTEXT_FILE, "utf-8"));
    }
  } catch (err) {
    console.warn("[ImageContext] Failed to load image-contexts.json:", err.message);
  }
  return {};
}

function saveStore(data) {
  try {
    fs.writeFileSync(IMAGE_CONTEXT_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("[ImageContext] Failed to save image-contexts.json:", err.message);
  }
}

export function getImageContext(contactName) {
  const store = loadStore();
  return store[contactName] || null;
}

export function upsertImageContext(contactName, imageContext) {
  const store = loadStore();
  store[contactName] = {
    contactName,
    ...imageContext,
    updatedAt: new Date().toISOString(),
  };
  saveStore(store);
  return store[contactName];
}

export function deleteImageContext(contactName) {
  const store = loadStore();
  if (!store[contactName]) return false;
  delete store[contactName];
  saveStore(store);
  return true;
}
