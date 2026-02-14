// server.js
import express from "express";
import axios from "axios";
import path from "path";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOURCE_URL =
  process.env.SOURCE_URL ||
  "";

const CORS_PROXY =
  process.env.CORS_PROXY ||
  "";

// Store results for dashboard
let results = [];
const MAX_RESULTS = 1000;

// ────────────── PARSER ──────────────
function parseList(txt) {
  return (txt || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isJson(body) {
  if (!body) return false;
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

function isCaptcha(body) {
  if (!body) return false;
  const t = body.toLowerCase();
  return (
    t.includes("captcha") ||
    t.includes("verify you are human") ||
    t.includes("verification") ||
    t.includes("robot") ||
    t.includes("cloudflare")
  );
}

const fetchText = async (url) => {
  try {
    const resp = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 20000,
      validateStatus: () => true,
      responseType: "text",
    });

    return {
      ok: true,
      text:
        typeof resp.data === "string"
          ? resp.data
          : JSON.stringify(resp.data),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

const buildProxyUrl = (u) => `${CORS_PROXY}/${u}`;

// ────────────── HIT URL ──────────────
async function hitUrl(url) {
  const timestamp = new Date().toLocaleTimeString();
  const direct = await fetchText(url);
  const directOk = direct.ok && !isCaptcha(direct.text) && isJson(direct.text);

  if (directOk) {
    console.log(`🔗 URL: ${url} | ✅ Direct OK | JSON`);
    results.unshift({
      url,
      status: 'direct',
      timestamp,
      message: 'Direct OK - JSON'
    });
    return;
  }

  const proxied = await fetchText(buildProxyUrl(url));
  const proxyOk =
    proxied.ok && !isCaptcha(proxied.text) && isJson(proxied.text);

  if (proxyOk) {
    console.log(`🔗 URL: ${url} | ✅ Proxy OK | JSON`);
    results.unshift({
      url,
      status: 'proxy',
      timestamp,
      message: 'Proxy OK - JSON'
    });
  } else {
    console.log(`🔗 URL: ${url} | ❌ Direct & Proxy | BUKAN JSON`);
    results.unshift({
      url,
      status: 'failed',
      timestamp,
      message: 'Failed - Not JSON'
    });
  }

  // Keep only last MAX_RESULTS
  if (results.length > MAX_RESULTS) {
    results = results.slice(0, MAX_RESULTS);
  }
}

// ────────────── PARALLEL WORKER ──────────────
async function mainLoop() {
  const WORKERS = 20;

  while (true) {
    try {
      const listResp = await fetchText(SOURCE_URL);
      const urls = listResp.ok ? parseList(listResp.text) : [];

      if (urls.length === 0) {
        console.log("❌ SOURCE kosong, ulangi…");
        continue;
      }

      console.log(`📌 Memuat ${urls.length} URL…`);

      let current = 0;

      async function worker() {
        while (true) {
          let u = urls[current++];
          if (!u) break;
          await hitUrl(u);
        }
      }

      const pool = [];
      for (let i = 0; i < WORKERS; i++) {
        pool.push(worker());
      }

      await Promise.all(pool);
    } catch (err) {
      console.log("❌ ERROR LOOP:", err.message);
    }
  }
}

// ────────────── HTTP STATUS ──────────────
const app = express();

// Serve static files
app.use(express.static('public'));

// API endpoint for results
app.get("/results", (req, res) => {
  const stats = {
    total: results.length,
    direct: results.filter(r => r.status === 'direct').length,
    proxy: results.filter(r => r.status === 'proxy').length,
    failed: results.filter(r => r.status === 'failed').length
  };
  
  res.json({ results, stats });
});

// API endpoint for config
app.get("/config", (req, res) => {
  res.json({
    sourceUrl: SOURCE_URL,
    corsProxy: CORS_PROXY,
    workers: 20
  });
});

// Serve HTML dashboard
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🌐 Web server OK on port ${PORT}`)
);

// Mulai mesin
mainLoop();