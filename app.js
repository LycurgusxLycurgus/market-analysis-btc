// app.js
// Vanilla frontend logic for short-term BTC and mid-term M2 signals.

const FRED_SERIES_ID = "M2SL";
const FRED_DIRECT_URL = "https://api.stlouisfed.org/fred/series/observations";

// ---- shared utils ----
function safeStringify(x) {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function makeAppError({ status, code, message, details }) {
  return { status, code, message, details: details ?? null };
}

function isAppError(x) {
  return x && typeof x === "object" && typeof x.code === "string" && typeof x.message === "string";
}

function anySignal(signals) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) return s;
    s.addEventListener("abort", onAbort, { once: true });
  }
  return ctrl.signal;
}

async function httpGetJson(url, { timeoutMs = 12000, signal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const mergedSignal = signal ? anySignal([signal, ctrl.signal]) : ctrl.signal;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: mergedSignal,
    });
    if (!res.ok) {
      throw makeAppError({
        status: res.status,
        code: "HTTP_NOT_OK",
        message: `HTTP ${res.status} from data source`,
        details: { url },
      });
    }
    return await res.json();
  } catch (err) {
    if (isAppError(err)) throw err;
    throw makeAppError({
      status: 0,
      code: "HTTP_FETCH_FAILED",
      message: "Network request failed (possible CORS or offline).",
      details: { url, raw: safeStringify(err) },
    });
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// SHORT TERM: BTC sentiment (MACD cross)
// ============================================================

function assertChartResponse(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.status !== "ok") return false;
  if (!Array.isArray(payload.values)) return false;
  if (payload.values.length < 60) return false;
  return true;
}

async function getBtcMarketPriceDaily({ timespan = "10years", sampled = false, signal, log } = {}) {
  const base = "https://api.blockchain.info/charts/market-price";
  const params = new URLSearchParams({
    timespan,
    format: "json",
    sampled: sampled ? "true" : "false",
    cors: "true",
  });
  const url = `${base}?${params.toString()}`;

  log?.info?.(`Fetching data from: ${url}`);

  const json = await httpGetJson(url, { signal });

  if (!assertChartResponse(json)) {
    throw makeAppError({
      status: 502,
      code: "BAD_UPSTREAM_SHAPE",
      message: "Upstream data shape unexpected.",
      details: { url },
    });
  }
  log?.info?.("Data fetch successful. Data points:", json.values.length);
  return json;
}

function toNumber(x) {
  const n = typeof x === "number" ? x : parseFloat(String(x));
  return Number.isFinite(n) ? n : NaN;
}

function monthKeyUTC(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function resampleToMonthEndCloses(dailySeries, log) {
  const latestByMonth = new Map();
  for (const p of dailySeries) {
    const d = new Date(p.x * 1000);
    const k = monthKeyUTC(d);
    const price = toNumber(p.y);
    if (!Number.isFinite(price)) continue;

    const existing = latestByMonth.get(k);
    if (!existing || d > existing.at) {
      latestByMonth.set(k, { month: k, close: price, at: d });
    }
  }
  const sorted = Array.from(latestByMonth.values()).sort((a, b) => a.at - b.at);
  log?.info?.(`Resampled to ${sorted.length} monthly candles.`);
  return sorted;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0) return out;
  const k = 2 / (period + 1);

  let start = -1;
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null || !Number.isFinite(values[i])) continue;
    let ok = true;
    for (let j = i - (period - 1); j <= i; j++) {
      if (j < 0 || values[j] == null || !Number.isFinite(values[j])) {
        ok = false;
        break;
      }
    }
    if (ok) {
      start = i;
      break;
    }
  }
  if (start === -1) return out;

  let sum = 0;
  for (let i = start - (period - 1); i <= start; i++) sum += values[i];
  let prevEma = sum / period;
  out[start] = prevEma;

  for (let i = start + 1; i < values.length; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) {
      out[i] = null;
      continue;
    }
    const next = (v - prevEma) * k + prevEma;
    out[i] = next;
    prevEma = next;
  }
  return out;
}

function macdSeries(closes) {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macd = closes.map((_, i) =>
    ema12[i] == null || ema26[i] == null ? null : ema12[i] - ema26[i]
  );
  const signal = ema(macd, 9);
  return { macd, signal };
}

function lastMacdCross({ macd, signal, months }) {
  let last = { dir: "none", atISO: null, idx: -1 };

  for (let i = 1; i < macd.length; i++) {
    if (macd[i] == null || signal[i] == null || macd[i - 1] == null || signal[i - 1] == null) continue;

    const prev = macd[i - 1] - signal[i - 1];
    const curr = macd[i] - signal[i];

    const up = prev <= 0 && curr > 0;
    const down = prev >= 0 && curr < 0;

    if (up || down) {
      last = { dir: up ? "up" : "down", atISO: months[i]?.month ?? null, idx: i };
    }
  }
  return last;
}

async function computeShortTermSentiment({ timespan = "10years", signal, log } = {}) {
  const raw = await getBtcMarketPriceDaily({ timespan, sampled: false, signal, log });
  const months = resampleToMonthEndCloses(raw.values, log);

  if (months.length < 40) {
    throw makeAppError({
      status: 422,
      code: "NOT_ENOUGH_DATA",
      message: "Not enough monthly points.",
      details: { months: months.length },
    });
  }

  const closes = months.map((m) => m.close);
  const { macd, signal: sig } = macdSeries(closes);

  const cross = lastMacdCross({ macd, signal: sig, months });
  log?.info?.("Last MACD Cross detected:", cross);

  if (cross.dir === "down") return "bearish";
  if (cross.dir === "up") return "bullish";

  const i = closes.length - 1;
  if (macd[i] != null && sig[i] != null) {
    return macd[i] - sig[i] >= 0 ? "bullish" : "bearish";
  }

  return "loading";
}

function setShortTermSentiment(ui, state) {
  ui.container.classList.remove("state-bullish", "state-bearish", "state-loading", "state-error");

  if (state === "bullish") {
    ui.container.classList.add("state-bullish");
    ui.text.textContent = "BULLISH";
    ui.status.style.backgroundColor = "var(--signal-bull)";
    return;
  }
  if (state === "bearish") {
    ui.container.classList.add("state-bearish");
    ui.text.textContent = "BEARISH";
    ui.status.style.backgroundColor = "var(--signal-bear)";
    return;
  }
  if (state === "error") {
    ui.container.classList.add("state-error");
    ui.text.textContent = "ERROR";
    ui.status.style.backgroundColor = "#ffb000";
    return;
  }

  ui.container.classList.add("state-loading");
  ui.text.textContent = "CALCULATING...";
  ui.status.style.backgroundColor = "var(--text-muted)";
}

export async function initShortTermSentiment({ container, text, status, note, onResult, onError }) {
  const log = {
    info: (msg, data) => console.log(`[BTC-Logic] ${msg}`, data ?? ""),
    error: (msg, data) => console.error(`[BTC-Logic] ${msg}`, data ?? ""),
  };

  const ui = { container, text, status };

  log.info("App starting...");
  setShortTermSentiment(ui, "loading");

  const abort = new AbortController();

  try {
    const result = await computeShortTermSentiment({ timespan: "10years", signal: abort.signal, log });
    log.info("Final Computed Sentiment:", result);

    if (result === "bullish" || result === "bearish") {
      setShortTermSentiment(ui, result);
      onResult?.(result);
    } else {
      setShortTermSentiment(ui, "loading");
    }
  } catch (err) {
    const normalized = isAppError(err)
      ? err
      : makeAppError({
          status: 0,
          code: "UNKNOWN_ERROR",
          message: "Unexpected error",
          details: { raw: safeStringify(err) },
        });
    log.error("Error during computation:", normalized);
    if (note) note.textContent = "Short-term data fetch failed. See console.";
    setShortTermSentiment(ui, "error");
    onError?.(normalized);
  }
}

// ============================================================
// MID TERM: M2 YoY signal (FRED proxy)
// ============================================================

function monthKey(dateStr) {
  return dateStr.slice(0, 7);
}

function addMonthsKey(yyyyMm, delta) {
  const [y, m] = yyyyMm.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() + delta);
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${yy}-${mm}`;
}

function defaultProxyUrl() {
  if (typeof window === "undefined") return "http://localhost:8787/fred";
  const origin = window?.location?.origin;
  const host = window?.location?.hostname || "";
  const port = window?.location?.port || "";
  if (!origin || origin === "null") return "http://localhost:8787/fred";
  const isLocalhost = host === "localhost" || host === "127.0.0.1";
  if (isLocalhost && port && port !== "8787") return "http://localhost:8787/fred";
  return `${origin}/fred`;
}

function isLocalOriginProxy(url) {
  if (!url) return false;
  try {
    const base = typeof window !== "undefined" ? window.location.origin : "http://localhost";
    const u = new URL(url, base);
    return u.origin === base && u.pathname === "/fred";
  } catch {
    return false;
  }
}

function fmtPct(x) {
  return Number.isFinite(x) ? `${x.toFixed(2)}%` : "-";
}

function computeYoYFromMonthlyLevels(monthToValue) {
  const months = Array.from(monthToValue.keys()).sort();
  const yoy = new Map();
  for (const mk of months) {
    const mk12 = addMonthsKey(mk, -12);
    if (!monthToValue.has(mk12)) continue;
    const v = monthToValue.get(mk);
    const v12 = monthToValue.get(mk12);
    if (!(Number.isFinite(v) && Number.isFinite(v12) && v12 !== 0)) continue;
    yoy.set(mk, (v / v12 - 1) * 100);
  }
  return yoy;
}

function findMonthAtOrBefore(sortedMonths, targetMonth) {
  const set = new Set(sortedMonths);
  if (set.has(targetMonth)) return targetMonth;
  let cur = targetMonth;
  for (let i = 0; i < 12; i++) {
    cur = addMonthsKey(cur, -1);
    if (set.has(cur)) return cur;
  }
  return null;
}

function buildFredUrl({ proxyUrl, apiKey, seriesId }) {
  const target = proxyUrl || FRED_DIRECT_URL;
  const base = typeof window !== "undefined" ? window.location.origin : "http://localhost";
  const u = new URL(target, base);
  u.searchParams.set("series_id", seriesId);
  if (apiKey) u.searchParams.set("api_key", apiKey);
  if (!proxyUrl) u.searchParams.set("file_type", "json");
  return u;
}

async function fetchObservations({ proxyUrl, apiKey, seriesId, log }) {
  if (!proxyUrl && !apiKey) {
    throw makeAppError({
      status: 400,
      code: "MISSING_PROXY_OR_API_KEY",
      message: "Missing proxy URL or API key.",
    });
  }
  const u = buildFredUrl({ proxyUrl, apiKey, seriesId });
  log?.(`GET ${u.toString()}`);
  const json = await httpGetJson(u.toString(), { timeoutMs: 12000 });
  if (!json.observations || !Array.isArray(json.observations)) {
    throw makeAppError({
      status: 502,
      code: "BAD_UPSTREAM_SHAPE",
      message: "Unexpected payload shape (missing observations).",
      details: { url: u.toString() },
    });
  }
  return json.observations;
}

function parseMonthlyLevels(observations) {
  const map = new Map();
  for (const o of observations) {
    const d = String(o.date || "");
    const vRaw = String(o.value || "").trim();
    if (!d || vRaw === "." || vRaw === "") continue;
    const v = Number(vRaw);
    if (!Number.isFinite(v)) continue;
    map.set(monthKey(d), v);
  }
  return map;
}

function setMidTermState(ui, state) {
  ui.container.classList.remove("state-bullish", "state-bearish", "state-loading", "state-error");

  if (state === "idle") {
    ui.container.classList.add("state-loading");
    ui.signal.textContent = "IDLE";
    ui.status.style.backgroundColor = "var(--text-muted)";
    return;
  }

  if (state === "bullish") {
    ui.container.classList.add("state-bullish");
    ui.signal.textContent = "BULLISH";
    ui.status.style.backgroundColor = "var(--signal-bull)";
    return;
  }
  if (state === "bearish") {
    ui.container.classList.add("state-bearish");
    ui.signal.textContent = "BEARISH";
    ui.status.style.backgroundColor = "var(--signal-bear)";
    return;
  }
  if (state === "error") {
    ui.container.classList.add("state-error");
    ui.signal.textContent = "ERROR";
    ui.status.style.backgroundColor = "#ffb000";
    return;
  }

  ui.container.classList.add("state-loading");
  ui.signal.textContent = "CALCULATING...";
  ui.status.style.backgroundColor = "var(--text-muted)";
}

export function initMidTermSignal({
  container,
  status,
  signal,
  subtitle,
  latest,
  prior,
  delta,
  meta,
  logBox,
  proxyUrl,
  apiKey,
  seriesId,
  runBtn,
}) {
  const logLine = (line) => {
    if (!logBox) return;
    logBox.textContent += `[${new Date().toISOString()}] ${line}\n`;
    logBox.scrollTop = logBox.scrollHeight;
  };

  const log = {
    info: (msg) => logLine(msg),
    error: (msg) => logLine(`ERROR: ${msg}`),
  };

  async function computeSignal({ apiKeyValue, proxyValue, seriesValue }) {
    const obs = await fetchObservations({
      proxyUrl: proxyValue,
      apiKey: apiKeyValue,
      seriesId: seriesValue,
      log: log.info,
    });
    logLine(`observations=${obs.length}`);

    const monthly = parseMonthlyLevels(obs);
    const yoy = computeYoYFromMonthlyLevels(monthly);
    const yoyMonths = Array.from(yoy.keys()).sort();
    if (yoyMonths.length < 6) throw new Error("Too few YoY points (need >= 12 months of levels).");

    const latestMk = yoyMonths[yoyMonths.length - 1];
    const latestYoy = yoy.get(latestMk);

    const targetMk = addMonthsKey(latestMk, -3);
    const priorMk = findMonthAtOrBefore(yoyMonths, targetMk);
    if (!priorMk) throw new Error("Could not find prior month near 3 months ago.");
    const priorYoy = yoy.get(priorMk);

    const deltaValue = latestYoy - priorYoy;
    const bullish = deltaValue > 0;

    return {
      signal: bullish ? "bullish" : "bearish",
      latestMk,
      latestYoy,
      priorMk,
      priorYoy,
      deltaValue,
      meta: `series_id=${seriesValue} | rule: latest > prior`,
    };
  }

  async function run() {
    if (logBox) logBox.textContent = "";
    setMidTermState(ui, "loading");

    const api = apiKey.value.trim();
    const proxy = proxyUrl.value.trim();
    const series = seriesId.value.trim() || FRED_SERIES_ID;

    try {
      const result = await computeSignal({ apiKeyValue: api, proxyValue: proxy, seriesValue: series });
      setMidTermState(ui, result.signal);
      latest.textContent = `${fmtPct(result.latestYoy)} (${result.latestMk})`;
      prior.textContent = `${fmtPct(result.priorYoy)} (${result.priorMk})`;
      delta.textContent = `${result.deltaValue >= 0 ? "+" : ""}${result.deltaValue.toFixed(2)} pp`;
      meta.textContent = result.meta;
      subtitle.textContent = "Computed from monthly levels (YoY derived).";
      logLine(
        `latest=${result.latestMk} yoy=${result.latestYoy.toFixed(2)} prior=${result.priorMk} yoy=${result.priorYoy.toFixed(2)} delta=${result.deltaValue.toFixed(2)}`
      );
    } catch (e) {
      setMidTermState(ui, "error");
      subtitle.textContent = "Fetch failed or parse error. Check proxy and key.";
      const msg = isAppError(e) ? e.message : String(e?.message || e);
      log.error(msg);
    }
  }

  const ui = { container, status, signal };

  setMidTermState(ui, "idle");
  runBtn.addEventListener("click", run);
}

export async function initMidTermSignalAuto({
  apiKey = "",
  seriesId = FRED_SERIES_ID,
  proxyUrl = defaultProxyUrl(),
  container,
  text,
  note,
  onResult,
  onError,
} = {}) {
  const log = {
    info: (msg, data) => console.log(`[M2-Logic] ${msg}`, data ?? ""),
    error: (msg, data) => console.error(`[M2-Logic] ${msg}`, data ?? ""),
  };

  const ui = container && text ? { container, text, note } : null;

  const setUi = (state, detail) => {
    if (!ui) return;
    ui.container.classList.remove("state-bullish", "state-bearish", "state-loading", "state-error");
    if (state === "bullish") {
      ui.container.classList.add("state-bullish");
      ui.text.textContent = "BULLISH";
    } else if (state === "bearish") {
      ui.container.classList.add("state-bearish");
      ui.text.textContent = "BEARISH";
    } else if (state === "error") {
      ui.container.classList.add("state-error");
      ui.text.textContent = "ERROR";
    } else {
      ui.container.classList.add("state-loading");
      ui.text.textContent = "CALCULATING...";
    }
    if (ui.note && detail) ui.note.textContent = detail;
  };

  setUi("loading", "Based on liquidity injection/withdrawal");

  try {
    const proxyValue = proxyUrl?.trim() || "";
    const apiValue = String(apiKey).trim();
    const seriesValue = seriesId?.trim() || FRED_SERIES_ID;

    let obs;
    try {
      obs = await fetchObservations({
        proxyUrl: proxyValue,
        apiKey: apiValue,
        seriesId: seriesValue,
        log: (line) => log.info(line),
      });
    } catch (err) {
      const is404 = isAppError(err) && err.code === "HTTP_NOT_OK" && err.status === 404;
      if (is404 && isLocalOriginProxy(proxyValue)) {
        const fallback = "http://localhost:8787/fred";
        log.info(`Proxy 404. Retrying with ${fallback}`);
        obs = await fetchObservations({
          proxyUrl: fallback,
          apiKey: apiValue,
          seriesId: seriesValue,
          log: (line) => log.info(line),
        });
      } else {
        throw err;
      }
    }

    const monthly = parseMonthlyLevels(obs);
    const yoy = computeYoYFromMonthlyLevels(monthly);
    const yoyMonths = Array.from(yoy.keys()).sort();
    if (yoyMonths.length < 6) throw new Error("Too few YoY points (need >= 12 months of levels).");

    const latestMk = yoyMonths[yoyMonths.length - 1];
    const latestYoy = yoy.get(latestMk);

    const targetMk = addMonthsKey(latestMk, -3);
    const priorMk = findMonthAtOrBefore(yoyMonths, targetMk);
    if (!priorMk) throw new Error("Could not find prior month near 3 months ago.");
    const priorYoy = yoy.get(priorMk);

    const deltaValue = latestYoy - priorYoy;
    const bullish = deltaValue > 0;

    const result = {
      signal: bullish ? "bullish" : "bearish",
      latestMk,
      latestYoy,
      priorMk,
      priorYoy,
      deltaValue,
      meta: `series_id=${seriesId} | rule: latest > prior`,
    };

    log.info("Computed mid-term signal", result);
    setUi(result.signal, "Based on liquidity injection/withdrawal (M2 YoY).");
    onResult?.(result);
  } catch (err) {
    const normalized = isAppError(err)
      ? err
      : makeAppError({
          status: 0,
          code: "MID_TERM_FAILED",
          message: "Mid-term fetch failed.",
          details: { raw: safeStringify(err) },
        });
    log.error("Mid-term error", normalized);
    setUi("error", "Mid-term data fetch failed. Check proxy server.");
    onError?.(normalized);
  }
}
