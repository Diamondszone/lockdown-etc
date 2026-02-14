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

// Store results dengan kategori terpisah
let urlDatabase = {
  all: [],           // Semua URL yang pernah diproses
  direct: new Set(), // URL sukses direct
  proxy: new Set(),  // URL sukses via proxy
  failed: new Set(), // URL gagal
  pending: new Set() // URL dalam antrian
};

let processingHistory = [];
const MAX_HISTORY = 1000;

// Statistik lengkap
let stats = {
  totalProcessed: 0,
  directSuccess: 0,
  proxySuccess: 0,
  failed: 0,
  uniqueUrls: 0,
  startTime: new Date(),
  lastProcessed: null,
  successRate: 0
};

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

// ────────────── URL MANAGEMENT ──────────────
function addToDatabase(url, status, details = {}) {
  const timestamp = new Date().toISOString();
  
  // Tambah ke semua URL
  if (!urlDatabase.all.includes(url)) {
    urlDatabase.all.push(url);
    stats.uniqueUrls = urlDatabase.all.length;
  }
  
  // Tambah ke kategori spesifik
  switch(status) {
    case 'direct':
      urlDatabase.direct.add(url);
      urlDatabase.proxy.delete(url);
      urlDatabase.failed.delete(url);
      stats.directSuccess++;
      break;
    case 'proxy':
      urlDatabase.proxy.add(url);
      urlDatabase.direct.delete(url);
      urlDatabase.failed.delete(url);
      stats.proxySuccess++;
      break;
    case 'failed':
      urlDatabase.failed.add(url);
      stats.failed++;
      break;
  }
  
  // Hapus dari pending
  urlDatabase.pending.delete(url);
  
  // Tambah ke history
  processingHistory.unshift({
    url,
    status,
    timestamp,
    details,
    category: status
  });
  
  // Batasi history
  if (processingHistory.length > MAX_HISTORY) {
    processingHistory = processingHistory.slice(0, MAX_HISTORY);
  }
  
  // Update statistik
  stats.totalProcessed++;
  stats.lastProcessed = timestamp;
  stats.successRate = ((stats.directSuccess + stats.proxySuccess) / stats.totalProcessed * 100).toFixed(2);
}

// Export database dalam berbagai format
function exportDatabase(format = 'json') {
  if (format === 'txt') {
    return {
      direct: Array.from(urlDatabase.direct).join('\n'),
      proxy: Array.from(urlDatabase.proxy).join('\n'),
      failed: Array.from(urlDatabase.failed).join('\n'),
      all: urlDatabase.all.join('\n')
    };
  }
  
  return {
    direct: Array.from(urlDatabase.direct),
    proxy: Array.from(urlDatabase.proxy),
    failed: Array.from(urlDatabase.failed),
    all: urlDatabase.all,
    stats,
    history: processingHistory.slice(0, 100)
  };
}

// Reset database
function resetDatabase() {
  urlDatabase = {
    all: [],
    direct: new Set(),
    proxy: new Set(),
    failed: new Set(),
    pending: new Set()
  };
  
  processingHistory = [];
  
  stats = {
    totalProcessed: 0,
    directSuccess: 0,
    proxySuccess: 0,
    failed: 0,
    uniqueUrls: 0,
    startTime: new Date(),
    lastProcessed: null,
    successRate: 0
  };
}

// ────────────── HIT URL ──────────────
async function hitUrl(url) {
  // Tandai sebagai pending
  urlDatabase.pending.add(url);
  
  const direct = await fetchText(url);
  const directOk = direct.ok && !isCaptcha(direct.text) && isJson(direct.text);

  if (directOk) {
    console.log(`🔗 URL: ${url} | ✅ Direct OK | JSON`);
    addToDatabase(url, 'direct', { 
      method: 'direct',
      responseSize: direct.text.length,
      timestamp: new Date().toISOString()
    });
    return;
  }

  const proxied = await fetchText(buildProxyUrl(url));
  const proxyOk =
    proxied.ok && !isCaptcha(proxied.text) && isJson(proxied.text);

  if (proxyOk) {
    console.log(`🔗 URL: ${url} | ✅ Proxy OK | JSON`);
    addToDatabase(url, 'proxy', { 
      method: 'proxy',
      responseSize: proxied.text.length,
      timestamp: new Date().toISOString()
    });
  } else {
    console.log(`🔗 URL: ${url} | ❌ Direct & Proxy | BUKAN JSON`);
    
    let errorDetails = {};
    if (!direct.ok) errorDetails.directError = direct.error;
    if (!proxied.ok) errorDetails.proxyError = proxied.error;
    if (direct.text && isCaptcha(direct.text)) errorDetails.directCaptcha = true;
    if (proxied.text && isCaptcha(proxied.text)) errorDetails.proxyCaptcha = true;
    
    addToDatabase(url, 'failed', errorDetails);
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
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }

      console.log(`📌 Memuat ${urls.length} URL…`);
      console.log(`📊 Statistik: Total=${stats.totalProcessed}, Direct=${stats.directSuccess}, Proxy=${stats.proxySuccess}, Failed=${stats.failed}`);

      let current = 0;

      async function worker() {
        while (true) {
          let u = urls[current++];
          if (!u) break;
          
          // Skip jika sudah diproses? (opsional)
          // if (urlDatabase.direct.has(u) || urlDatabase.proxy.has(u) || urlDatabase.failed.has(u)) continue;
          
          await hitUrl(u);
        }
      }

      const pool = [];
      for (let i = 0; i < WORKERS; i++) {
        pool.push(worker());
      }

      await Promise.all(pool);
      
      // Istirahat sebentar sebelum loop berikutnya
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (err) {
      console.log("❌ ERROR LOOP:", err.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// ────────────── HTTP ENDPOINTS ──────────────
const app = express();

// Serve static files
app.use(express.static('public'));

// API endpoint untuk dashboard
app.get("/api/stats", (req, res) => {
  res.json({
    stats,
    counts: {
      direct: urlDatabase.direct.size,
      proxy: urlDatabase.proxy.size,
      failed: urlDatabase.failed.size,
      pending: urlDatabase.pending.size,
      total: urlDatabase.all.length
    }
  });
});

// API endpoint untuk history
app.get("/api/history", (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const status = req.query.status;
  
  let history = processingHistory;
  if (status) {
    history = history.filter(h => h.status === status);
  }
  
  res.json(history.slice(0, limit));
});

// API endpoint untuk mendapatkan URL berdasarkan kategori
app.get("/api/urls/:category", (req, res) => {
  const category = req.params.category;
  const format = req.query.format || 'json';
  
  let urls;
  switch(category) {
    case 'direct':
      urls = Array.from(urlDatabase.direct);
      break;
    case 'proxy':
      urls = Array.from(urlDatabase.proxy);
      break;
    case 'failed':
      urls = Array.from(urlDatabase.failed);
      break;
    case 'pending':
      urls = Array.from(urlDatabase.pending);
      break;
    case 'all':
      urls = urlDatabase.all;
      break;
    default:
      return res.status(400).json({ error: 'Invalid category' });
  }
  
  if (format === 'txt') {
    res.setHeader('Content-Type', 'text/plain');
    res.send(urls.join('\n'));
  } else {
    res.json({ 
      category, 
      count: urls.length, 
      urls 
    });
  }
});

// API endpoint untuk export semua data
app.get("/api/export/:format?", (req, res) => {
  const format = req.params.format || 'json';
  const data = exportDatabase(format);
  
  if (format === 'txt') {
    res.setHeader('Content-Type', 'text/plain');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    // Kirim multiple files sebagai zip? Atau pilih salah satu
    res.send(`
# URL DATABASE EXPORT - ${timestamp}
# ====================================

## DIRECT SUCCESS (${data.direct.split('\n').length} URLs)
${data.direct}

## PROXY SUCCESS (${data.proxy.split('\n').length} URLs)
${data.proxy}

## FAILED (${data.failed.split('\n').length} URLs)
${data.failed}

## ALL URLS (${data.all.split('\n').length} URLs)
${data.all}
    `);
  } else {
    res.json(data);
  }
});

// API endpoint untuk reset database
app.post("/api/reset", (req, res) => {
  resetDatabase();
  res.json({ message: 'Database reset successfully', stats });
});

// API endpoint untuk config
app.get("/api/config", (req, res) => {
  res.json({
    sourceUrl: SOURCE_URL,
    corsProxy: CORS_PROXY,
    workers: 20,
    maxHistory: MAX_HISTORY,
    uptime: process.uptime()
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
