// proxy.js
// Minimal FRED proxy that adds CORS.
// Run: node proxy.js
// Then your frontend calls: http://localhost:8787/fred?series_id=M2SL (uses FRED_API_KEY env)

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";

const PORT = process.env.PORT || 8787;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadEnvFile() {
  if (process.env.FRED_API_KEY) return;
  try {
    const envPath = path.join(__dirname, ".env");
    const raw = await fs.readFile(envPath, "utf8");
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (key && !(key in process.env)) process.env[key] = value;
    }
  } catch {
    // no .env or unreadable, ignore
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function sendFile(res, filePath, contentType) {
  try {
    const body = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch (e) {
    sendJson(res, 404, { error: "Not found" });
  }
}

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
    });
    return res.end();
  }

  try {
    await loadEnvFile();
    const u = new URL(req.url, `http://localhost:${PORT}`);

    if (u.pathname === "/" || u.pathname === "/index.html") {
      return sendFile(res, path.join(__dirname, "index.html"), "text/html; charset=utf-8");
    }
    if (u.pathname === "/app.js") {
      return sendFile(res, path.join(__dirname, "app.js"), "text/javascript; charset=utf-8");
    }

    if (u.pathname === "/btc") {
      const timespan = u.searchParams.get("timespan") || "10years";
      const sampled = u.searchParams.get("sampled") || "false";
      const params = new URLSearchParams({
        timespan,
        format: "json",
        sampled,
        cors: "true",
      });
      const btcUrl = `https://api.blockchain.info/charts/market-price?${params.toString()}`;

      const r = await fetch(btcUrl);
      const text = await r.text();
      if (!r.ok) return sendJson(res, r.status, { error: "BTC request failed", status: r.status, body: text });

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      });
      return res.end(text);
    }

    if (u.pathname !== "/fred") return sendJson(res, 404, { error: "Not found" });

    const series_id = u.searchParams.get("series_id") || "M2SL";
    const api_key = u.searchParams.get("api_key") || process.env.FRED_API_KEY;
    if (!api_key) {
      return sendJson(res, 400, {
        error: "Missing api_key",
        message: "Set FRED_API_KEY env var or pass api_key query param.",
      });
    }

    // FRED series observations endpoint (JSON)
    // Docs: /fred/series/observations with file_type=json, series_id, api_key, etc. :contentReference[oaicite:3]{index=3}
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear() - 6, now.getUTCMonth(), 1));
    const observation_start = start.toISOString().slice(0, 10);

    const fredUrl =
      `https://api.stlouisfed.org/fred/series/observations` +
      `?series_id=${encodeURIComponent(series_id)}` +
      `&api_key=${encodeURIComponent(api_key)}` +
      `&file_type=json` +
      `&sort_order=asc` +
      `&observation_start=${encodeURIComponent(observation_start)}`;

    const r = await fetch(fredUrl);
    const text = await r.text();

    // Pass through (still JSON if ok, but we’ll wrap errors safely)
    if (!r.ok) return sendJson(res, r.status, { error: "FRED request failed", status: r.status, body: text });

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    res.end(text);
  } catch (e) {
    sendJson(res, 500, { error: "Proxy error", message: String(e?.message || e) });
  }
}).listen(PORT, () => {
  console.log(`Proxy running on http://localhost:${PORT} (endpoints: /fred, /btc)`);
});
