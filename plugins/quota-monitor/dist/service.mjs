import { createRequire } from 'node:module';const require=createRequire(import.meta.url);

// src/service.ts
import readline from "node:readline";

// src/volcengine.ts
import { createHmac, createHash } from "node:crypto";

// src/platform.ts
var TIER_FIVE_HOUR = "five_hour";
var TIER_WEEKLY = "weekly";
var TIER_MONTHLY = "monthly";
var TIER_DAILY = "daily";
function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return void 0;
}
function epochToIso(v) {
  const n = num(v);
  if (n === void 0) return null;
  const ms = n < 1e12 ? n * 1e3 : n;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
function parseResetTime(v) {
  if (typeof v === "string" && !/^\d+$/.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return null;
  }
  return epochToIso(v);
}
var WINDOW_LABELS = {
  [TIER_FIVE_HOUR]: "5-hour",
  [TIER_WEEKLY]: "Weekly",
  [TIER_MONTHLY]: "Monthly",
  [TIER_DAILY]: "Daily"
};

// src/volcengine.ts
var OPENAPI_HOST = "open.volcengineapi.com";
var API_VERSION = "2024-01-01";
var SERVICE = "ark";
var CONTENT_TYPE = "application/json; charset=utf-8";
var SIGNED_HEADERS = "host;x-date;x-content-sha256;content-type";
var hmac = (key, data) => createHmac("sha256", key).update(data).digest();
var sha256hex = (data) => createHash("sha256").update(data).digest("hex");
function uriEncode(input) {
  return encodeURIComponent(input).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}
function canonicalQuery(action, region) {
  const pairs = [
    ["Action", action],
    ["Region", region],
    ["Version", API_VERSION]
  ];
  pairs.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return pairs.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join("&");
}
function signV4(accessKeyId, secretAccessKey, region, action, body, now = /* @__PURE__ */ new Date()) {
  const xDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const shortDate = xDate.slice(0, 8);
  const contentSha256 = sha256hex(body);
  const canonicalHeaders = `host:${OPENAPI_HOST}
x-date:${xDate}
x-content-sha256:${contentSha256}
content-type:${CONTENT_TYPE}
`;
  const canonicalRequest = `POST
/
${canonicalQuery(action, region)}
${canonicalHeaders}
${SIGNED_HEADERS}
${contentSha256}`;
  const credentialScope = `${shortDate}/${region}/${SERVICE}/request`;
  const stringToSign = `HMAC-SHA256
${xDate}
${credentialScope}
` + sha256hex(canonicalRequest);
  const kDate = hmac(Buffer.from(secretAccessKey, "utf8"), shortDate);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, "request");
  const signature = Buffer.from(hmac(kSigning, stringToSign)).toString("hex");
  return {
    authorization: `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`,
    xDate,
    contentSha256
  };
}
function deriveRegion(baseUrl) {
  const rest = baseUrl.replace(/^[a-z]+:\/\//i, "").split("/")[0] ?? "";
  const part = rest.split(".").find((p) => p.startsWith("cn-") || p.startsWith("ap-"));
  return part ?? "cn-beijing";
}
function isAuthErrorCode(code) {
  const c = code.toLowerCase();
  return c.includes("auth") || c.includes("signature") || c.includes("accessdenied") || c.includes("denied") || c.includes("unauthorized") || c.includes("forbidden") || c.includes("credential") || c.includes("token");
}
function responseError(body) {
  if (!body || typeof body !== "object") return null;
  const b = body;
  const err = b.ResponseMetadata?.Error ?? b.Error;
  if (!err || typeof err !== "object") return null;
  const e = err;
  const code = typeof e.Code === "string" ? e.Code : "";
  const message = typeof e.Message === "string" ? e.Message : "";
  if (!code && !message) return null;
  return { code, message };
}
function parseAfpTiers(result) {
  const tiers = [];
  if (!result || typeof result !== "object") return tiers;
  const r = result;
  for (const [key, name] of [
    ["AFPFiveHour", TIER_FIVE_HOUR],
    ["AFPWeekly", TIER_WEEKLY],
    ["AFPMonthly", TIER_MONTHLY]
  ]) {
    const win = r[key];
    if (!win || typeof win !== "object") continue;
    const w = win;
    const quota = num(w.Quota) ?? 0;
    if (quota <= 0) continue;
    const used = num(w.Used) ?? 0;
    const utilization = used / quota * 100;
    tiers.push({
      name,
      label: WINDOW_LABELS[name],
      utilization,
      resets_at: epochToIso(w.ResetTime),
      used,
      quota
    });
  }
  return tiers;
}
var CODING_WINDOW_LABELS = {
  session: TIER_FIVE_HOUR,
  "5h": TIER_FIVE_HOUR,
  fivehour: TIER_FIVE_HOUR,
  five_hour: TIER_FIVE_HOUR,
  rolling_5h: TIER_FIVE_HOUR,
  weekly: TIER_WEEKLY,
  week: TIER_WEEKLY,
  "7d": TIER_WEEKLY,
  monthly: TIER_MONTHLY,
  month: TIER_MONTHLY
};
function parseCodingPlanTiers(result) {
  const tiers = [];
  if (!result || typeof result !== "object") return tiers;
  const r = result;
  const arr = Array.isArray(r.QuotaUsage) && r.QuotaUsage || Array.isArray(r.Usages) && r.Usages || Array.isArray(r.Details) && r.Details;
  if (!arr) return tiers;
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const it = item;
    const labelRaw = it.Level ?? it.Type ?? it.Period ?? it.Label ?? it.Window;
    if (typeof labelRaw !== "string") continue;
    const name = CODING_WINDOW_LABELS[labelRaw.toLowerCase()];
    if (!name) continue;
    const utilization = num(it.Percent) ?? num(it.UsedPercent) ?? num(it.UsagePercent) ?? 0;
    tiers.push({
      name,
      label: WINDOW_LABELS[name],
      utilization,
      resets_at: epochToIso(it.ResetTime ?? it.ResetTimestamp)
    });
  }
  return tiers;
}
var AKSK_HINT = "Check the AccessKey ID / Secret are correct and the account has Ark usage-query (OpenAPI) permission.";
async function callOpenApi(http, region, ak, sk, action) {
  const query = canonicalQuery(action, region);
  const url = `https://${OPENAPI_HOST}/?${query}`;
  const { authorization, xDate, contentSha256 } = signV4(ak, sk, region, action, Buffer.alloc(0));
  let res;
  try {
    res = await http.request({
      url,
      method: "POST",
      headers: {
        "X-Date": xDate,
        "X-Content-Sha256": contentSha256,
        "Content-Type": CONTENT_TYPE,
        Authorization: authorization
      },
      body: "",
      timeoutMs: 15e3
    });
  } catch (err2) {
    return { ok: false, kind: "transient", message: `Network error: ${err2.message}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: "auth", message: `Authentication failed (HTTP ${res.status}). ${AKSK_HINT}` };
  }
  let body;
  try {
    body = JSON.parse(res.body);
  } catch {
    return { ok: false, kind: "soft", message: `API error (HTTP ${res.status}): failed to parse response` };
  }
  const err = responseError(body);
  if (err) {
    if (isAuthErrorCode(err.code)) {
      return {
        ok: false,
        kind: "auth",
        message: `Authentication failed (HTTP ${res.status}, ${err.code}): ${err.message}. ${AKSK_HINT}`
      };
    }
    return { ok: false, kind: "soft", message: `API error (HTTP ${res.status}, ${err.code}): ${err.message}` };
  }
  if (!res.status.toString().startsWith("2")) {
    return { ok: false, kind: "soft", message: `API error (HTTP ${res.status})` };
  }
  return { ok: true, body };
}
async function queryVolcengine(http, region, ak, sk) {
  const agent = await callOpenApi(http, region, ak, sk, "GetAFPUsage");
  if (agent.ok) {
    const r = agent.body.Result;
    const tiers = parseAfpTiers(r);
    if (tiers.length > 0) {
      const planType = r && typeof r === "object" && typeof r.PlanType === "string" ? r.PlanType : null;
      return { data: { planKind: "agent", planType, tiers }, error: null };
    }
  } else if (agent.kind === "auth" || agent.kind === "transient") {
    return { data: null, error: { kind: agent.kind, message: agent.message } };
  }
  const coding = await callOpenApi(http, region, ak, sk, "GetCodingPlanUsage");
  if (coding.ok) {
    const r = coding.body.Result;
    const tiers = parseCodingPlanTiers(r);
    return { data: { planKind: tiers.length > 0 ? "coding" : null, planType: null, tiers }, error: null };
  }
  if (coding.kind === "auth") {
    return { data: null, error: { kind: coding.kind, message: coding.message } };
  }
  return {
    data: null,
    error: { kind: "soft", message: agent.ok ? coding.message : agent.message }
  };
}
var volcengineAdapter = {
  id: "volcengine",
  label: "Ark",
  isConfigured: (cfg) => Boolean(cfg.volcAccessKeyId && cfg.volcSecretAccessKey),
  query: (http, cfg) => queryVolcengine(http, deriveRegion(cfg.volcBaseUrl), cfg.volcAccessKeyId, cfg.volcSecretAccessKey)
};

// src/zhipu.ts
function quotaBase(baseUrl) {
  return baseUrl.toLowerCase().includes("bigmodel.cn") ? "https://open.bigmodel.cn" : "https://api.z.ai";
}
function classifyWindowUnit(unit) {
  if (num(unit) === 3) return TIER_FIVE_HOUR;
  if (num(unit) === 6) return TIER_WEEKLY;
  return null;
}
function parseZhipuTiers(data) {
  const fiveHour = [];
  const weekly = [];
  const unclassified = [];
  if (!data || typeof data !== "object") return [];
  const d = data;
  const limits = Array.isArray(d.limits) ? d.limits : [];
  for (const item of limits) {
    if (!item || typeof item !== "object") continue;
    const it = item;
    const type = typeof it.type === "string" ? it.type.toLowerCase() : "";
    if (type !== "tokens_limit" && type !== "credit_limit") {
      continue;
    }
    const percentage = num(it.percentage) ?? 0;
    const resetMs = num(it.nextResetTime) ?? null;
    const entry = { resetMs, percentage, resetsAt: epochToIso(it.nextResetTime) };
    const slot = classifyWindowUnit(it.unit);
    if (slot === TIER_FIVE_HOUR) fiveHour.push(entry);
    else if (slot === TIER_WEEKLY) weekly.push(entry);
    else unclassified.push(entry);
  }
  unclassified.sort((a, b) => {
    if (a.resetMs === null && b.resetMs !== null) return -1;
    if (a.resetMs !== null && b.resetMs === null) return 1;
    return (a.resetMs ?? 0) - (b.resetMs ?? 0);
  });
  for (const entry of unclassified) {
    if (fiveHour.length === 0) fiveHour.push(entry);
    else if (weekly.length === 0) weekly.push(entry);
  }
  const tiers = [];
  for (const [name, entries] of [
    [TIER_FIVE_HOUR, fiveHour],
    [TIER_WEEKLY, weekly]
  ]) {
    for (const e of entries.slice(0, 1)) {
      tiers.push({ name, label: WINDOW_LABELS[name], utilization: e.percentage, resets_at: e.resetsAt });
    }
  }
  return tiers;
}
async function queryZhipu(http, baseUrl, apiKey) {
  const url = `${quotaBase(baseUrl)}/api/monitor/usage/quota/limit`;
  let res;
  try {
    res = await http.request({
      url,
      method: "GET",
      headers: {
        Authorization: apiKey,
        // NOTE: no Bearer prefix for Zhipu
        "Content-Type": "application/json",
        "Accept-Language": "en-US,en"
      },
      timeoutMs: 15e3
    });
  } catch (err) {
    return { data: null, error: { kind: "transient", message: `Network error: ${err.message}` } };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      data: null,
      error: { kind: "auth", message: `Authentication failed (HTTP ${res.status}): invalid API key` }
    };
  }
  if (!res.status.toString().startsWith("2")) {
    return { data: null, error: { kind: "soft", message: `API error (HTTP ${res.status}): ${res.body.slice(0, 300)}` } };
  }
  let body;
  try {
    body = JSON.parse(res.body);
  } catch {
    return { data: null, error: { kind: "soft", message: "Failed to parse response" } };
  }
  if (!body || typeof body !== "object") {
    return { data: null, error: { kind: "soft", message: "Malformed response body" } };
  }
  const b = body;
  if (b.success === false) {
    const msg = typeof b.msg === "string" ? b.msg : "Unknown error";
    return { data: null, error: { kind: "soft", message: `API error: ${msg}` } };
  }
  if (!b.data || typeof b.data !== "object") {
    return { data: null, error: { kind: "soft", message: "Missing 'data' field in response" } };
  }
  const data = b.data;
  const tiers = parseZhipuTiers(data);
  const planType = typeof data.level === "string" ? data.level : null;
  return {
    data: { planKind: "subscription", planType, tiers },
    error: null
  };
}
var zhipuAdapter = {
  id: "zhipu",
  label: "Zhipu",
  isConfigured: (cfg) => Boolean(cfg.zhipuApiKey),
  query: (http, cfg) => queryZhipu(http, cfg.zhipuBaseUrl, cfg.zhipuApiKey)
};

// src/kimi.ts
var KIMI_URL = "https://api.kimi.com/coding/v1/usages";
function tierFromLimitDetail(detail, name) {
  if (!detail || typeof detail !== "object") return null;
  const d = detail;
  const limit = num(d.limit) ?? 1;
  const remaining = num(d.remaining) ?? 0;
  const used = Math.max(0, limit - remaining);
  const utilization = limit > 0 ? used / limit * 100 : 0;
  return {
    name,
    label: WINDOW_LABELS[name],
    utilization,
    resets_at: epochToIso(d.resetTime),
    used,
    quota: limit
  };
}
function parseKimiTiers(body) {
  const tiers = [];
  if (!body || typeof body !== "object") return tiers;
  const b = body;
  if (Array.isArray(b.limits)) {
    for (const item of b.limits) {
      if (!item || typeof item !== "object") continue;
      const tier = tierFromLimitDetail(item.detail, TIER_FIVE_HOUR);
      if (tier) {
        tiers.push(tier);
        break;
      }
    }
  }
  const weekly = tierFromLimitDetail(b.usage, TIER_WEEKLY);
  if (weekly) tiers.push(weekly);
  return tiers;
}
async function queryKimi(http, apiKey) {
  let res;
  try {
    res = await http.request({
      url: KIMI_URL,
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      timeoutMs: 15e3
    });
  } catch (err) {
    return { data: null, error: { kind: "transient", message: `Network error: ${err.message}` } };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      data: null,
      error: { kind: "auth", message: `Authentication failed (HTTP ${res.status}): invalid API key` }
    };
  }
  if (!res.status.toString().startsWith("2")) {
    return { data: null, error: { kind: "soft", message: `API error (HTTP ${res.status}): ${res.body.slice(0, 300)}` } };
  }
  let body;
  try {
    body = JSON.parse(res.body);
  } catch {
    return { data: null, error: { kind: "soft", message: "Failed to parse response" } };
  }
  const tiers = parseKimiTiers(body);
  if (tiers.length === 0) {
    return { data: null, error: { kind: "soft", message: "Response did not contain usable quota windows" } };
  }
  return { data: { planKind: "subscription", planType: null, tiers }, error: null };
}
var kimiAdapter = {
  id: "kimi",
  label: "Kimi",
  isConfigured: (cfg) => Boolean(cfg.kimiApiKey),
  query: (http, cfg) => queryKimi(http, cfg.kimiApiKey)
};

// src/minimax.ts
function parseMinimaxTiers(body) {
  const tiers = [];
  if (!body || typeof body !== "object") return tiers;
  const b = body;
  const remains = Array.isArray(b.model_remains) ? b.model_remains : [];
  const item = remains.find((it) => {
    if (!it || typeof it !== "object") return false;
    return it.model_name === "general";
  });
  if (!item || typeof item !== "object") return tiers;
  const g = item;
  const intervalRemain = num(g.current_interval_remaining_percent);
  if (intervalRemain !== void 0) {
    tiers.push({
      name: TIER_FIVE_HOUR,
      label: WINDOW_LABELS[TIER_FIVE_HOUR],
      utilization: 100 - intervalRemain,
      resets_at: epochToIso(g.end_time)
    });
  }
  if (num(g.current_weekly_status) === 1) {
    const weeklyRemain = num(g.current_weekly_remaining_percent);
    if (weeklyRemain !== void 0) {
      tiers.push({
        name: TIER_WEEKLY,
        label: WINDOW_LABELS[TIER_WEEKLY],
        utilization: 100 - weeklyRemain,
        resets_at: epochToIso(g.weekly_end_time)
      });
    }
  }
  return tiers;
}
async function queryMinimax(http, apiKey, region) {
  const host = region === "cn" ? "api.minimaxi.com" : "api.minimax.io";
  const url = `https://${host}/v1/api/openplatform/coding_plan/remains`;
  let res;
  try {
    res = await http.request({
      url,
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      timeoutMs: 15e3
    });
  } catch (err) {
    return { data: null, error: { kind: "transient", message: `Network error: ${err.message}` } };
  }
  if (res.status === 401 || res.status === 403) {
    return { data: null, error: { kind: "auth", message: `Authentication failed (HTTP ${res.status}): invalid API key` } };
  }
  if (!res.status.toString().startsWith("2")) {
    return { data: null, error: { kind: "soft", message: `API error (HTTP ${res.status}): ${res.body.slice(0, 300)}` } };
  }
  let body;
  try {
    body = JSON.parse(res.body);
  } catch {
    return { data: null, error: { kind: "soft", message: "Failed to parse response" } };
  }
  if (!body || typeof body !== "object") {
    return { data: null, error: { kind: "soft", message: "Malformed response body" } };
  }
  const b = body;
  const baseResp = b.base_resp;
  if (baseResp && typeof baseResp === "object") {
    const code = num(baseResp.status_code) ?? -1;
    if (code !== 0) {
      const msg = baseResp.status_msg ?? "Unknown error";
      return { data: null, error: { kind: "soft", message: `API error (code ${code}): ${String(msg)}` } };
    }
  }
  const tiers = parseMinimaxTiers(body);
  if (tiers.length === 0) {
    return { data: null, error: { kind: "soft", message: "Response did not contain a usable general-plan quota" } };
  }
  return { data: { planKind: "subscription", planType: null, tiers }, error: null };
}
var minimaxAdapter = {
  id: "minimax",
  label: "MiniMax",
  isConfigured: (cfg) => Boolean(cfg.minimaxApiKey),
  query: (http, cfg) => queryMinimax(http, cfg.minimaxApiKey, cfg.minimaxRegion)
};

// src/zenmux.ts
function parseZenmuxTiers(data) {
  const tiers = [];
  if (!data || typeof data !== "object") return tiers;
  const d = data;
  const q5h = d.quota_5_hour;
  if (q5h && typeof q5h === "object") {
    const w = q5h;
    const pct = num(w.usage_percentage) ?? 0;
    tiers.push({
      name: TIER_FIVE_HOUR,
      label: WINDOW_LABELS[TIER_FIVE_HOUR],
      utilization: pct * 100,
      resets_at: parseResetTime(w.resets_at)
    });
  }
  const q7d = d.quota_7_day;
  if (q7d && typeof q7d === "object") {
    const w = q7d;
    const pct = num(w.usage_percentage) ?? 0;
    tiers.push({
      name: TIER_WEEKLY,
      label: WINDOW_LABELS[TIER_WEEKLY],
      utilization: pct * 100,
      resets_at: parseResetTime(w.resets_at)
    });
  }
  return tiers;
}
function planInfo(data) {
  if (!data || typeof data !== "object") return null;
  const d = data;
  const plan = d.plan && typeof d.plan === "object" ? d.plan : {};
  const tier = typeof plan.tier === "string" ? plan.tier.trim() : "";
  const status = typeof d.account_status === "string" ? d.account_status.trim() : "";
  if (!tier && !status) return null;
  if (tier && status) return `${tier} (${status})`;
  return tier || status;
}
async function queryZenmux(http, baseUrl, apiKey) {
  let res;
  try {
    res = await http.request({
      url: baseUrl,
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      timeoutMs: 15e3
    });
  } catch (err) {
    return { data: null, error: { kind: "transient", message: `Network error: ${err.message}` } };
  }
  if (res.status === 401 || res.status === 403) {
    return { data: null, error: { kind: "auth", message: `Authentication failed (HTTP ${res.status}): invalid token` } };
  }
  if (!res.status.toString().startsWith("2")) {
    return { data: null, error: { kind: "soft", message: `API error (HTTP ${res.status}): ${res.body.slice(0, 300)}` } };
  }
  let body;
  try {
    body = JSON.parse(res.body);
  } catch {
    return { data: null, error: { kind: "soft", message: "Failed to parse response" } };
  }
  if (!body || typeof body !== "object") {
    return { data: null, error: { kind: "soft", message: "Malformed response body" } };
  }
  const b = body;
  if (b.success !== true) {
    const msg = typeof b.message === "string" ? b.message : "Unknown error";
    return { data: null, error: { kind: "soft", message: `API error: ${msg}` } };
  }
  if (!b.data || typeof b.data !== "object") {
    return { data: null, error: { kind: "soft", message: "Missing 'data' field in response" } };
  }
  const tiers = parseZenmuxTiers(b.data);
  if (tiers.length === 0) {
    return { data: null, error: { kind: "soft", message: "Response did not contain usable quota windows" } };
  }
  return { data: { planKind: "subscription", planType: planInfo(b.data), tiers }, error: null };
}
var zenmuxAdapter = {
  id: "zenmux",
  label: "ZenMux",
  isConfigured: (cfg) => Boolean(cfg.zenmuxUrl.trim() && cfg.zenmuxApiKey),
  query: (http, cfg) => queryZenmux(http, cfg.zenmuxUrl, cfg.zenmuxApiKey)
};

// src/opencodego.ts
var GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
function parseOpenCodeGoTiers(body) {
  const tiers = [];
  if (!body || typeof body !== "object") return tiers;
  const usage = body.usage;
  if (!usage || typeof usage !== "object") return tiers;
  const u = usage;
  for (const [key, name] of [
    ["rolling", TIER_FIVE_HOUR],
    ["weekly", TIER_WEEKLY],
    ["monthly", TIER_MONTHLY]
  ]) {
    const window = u[key];
    if (!window || typeof window !== "object") continue;
    const w = window;
    const percent = num(w.percent);
    if (percent === void 0) continue;
    tiers.push({
      name,
      label: WINDOW_LABELS[name],
      utilization: percent,
      // percent==0 → upstream resetsAt is a placeholder; do not show a countdown.
      resets_at: percent > 0 ? parseResetTime(w.resetsAt) : null
    });
  }
  return tiers;
}
async function queryOpenCodeGo(http, apiKey) {
  let res;
  try {
    res = await http.request({
      url: GO_USAGE_URL,
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      timeoutMs: 15e3
    });
  } catch (err) {
    return { data: null, error: { kind: "transient", message: `Network error: ${err.message}` } };
  }
  if (res.status === 403) {
    return { data: null, error: { kind: "soft", message: "API key is valid but has no OpenCode Go subscription (HTTP 403)" } };
  }
  if (res.status === 401) {
    return { data: null, error: { kind: "auth", message: "Authentication failed (HTTP 401): invalid API key" } };
  }
  if (!res.status.toString().startsWith("2")) {
    return { data: null, error: { kind: "soft", message: `API error (HTTP ${res.status}): ${res.body.slice(0, 300)}` } };
  }
  let body;
  try {
    body = JSON.parse(res.body);
  } catch {
    return { data: null, error: { kind: "soft", message: "Failed to parse response" } };
  }
  const tiers = parseOpenCodeGoTiers(body);
  if (tiers.length === 0) {
    return { data: null, error: { kind: "soft", message: "Response did not contain usable usage windows" } };
  }
  return { data: { planKind: "subscription", planType: null, tiers }, error: null };
}
var opencodeGoAdapter = {
  id: "opencodeGo",
  label: "OpenCode Go",
  isConfigured: (cfg) => Boolean(cfg.opencodeGoApiKey),
  query: (http, cfg) => queryOpenCodeGo(http, cfg.opencodeGoApiKey)
};

// src/generic.ts
var WINDOW_KEYS = {
  five_hour: TIER_FIVE_HOUR,
  fivehour: TIER_FIVE_HOUR,
  "5h": TIER_FIVE_HOUR,
  rolling: TIER_FIVE_HOUR,
  weekly: TIER_WEEKLY,
  week: TIER_WEEKLY,
  "7d": TIER_WEEKLY,
  monthly: TIER_MONTHLY,
  month: TIER_MONTHLY,
  daily: TIER_DAILY,
  day: TIER_DAILY
};
function windowUtilization(obj) {
  const pct = num(obj.percent ?? obj.percentage ?? obj.utilization ?? obj.usedPercent ?? obj.usagePercent);
  if (pct !== void 0) return pct;
  const used = num(obj.used ?? obj.usedValue);
  const quota = num(obj.quota ?? obj.limit ?? obj.max ?? obj.total);
  if (used !== void 0 && quota !== void 0 && quota > 0) return used / quota * 100;
  return null;
}
function parseGenericWindows(body) {
  const tiers = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    const obj = node;
    for (const [key, value] of Object.entries(obj)) {
      const name = WINDOW_KEYS[key.toLowerCase()];
      if (name && value && typeof value === "object" && !Array.isArray(value)) {
        const w = value;
        const utilization = windowUtilization(w);
        if (utilization !== null) {
          tiers.push({
            name,
            label: WINDOW_LABELS[name],
            utilization,
            resets_at: parseResetTime(w.resetsAt ?? w.resetTime ?? w.reset_time),
            used: num(w.used ?? w.usedValue),
            quota: num(w.quota ?? w.limit ?? w.max ?? w.total)
          });
        }
      }
      if (value && typeof value === "object") walk(value);
    }
  };
  walk(body);
  const seen = /* @__PURE__ */ new Set();
  return tiers.filter((t) => {
    if (seen.has(t.name)) return false;
    seen.add(t.name);
    return true;
  });
}
function parseBalance(body) {
  if (!body || typeof body !== "object") return null;
  const b = body;
  const data = b.data && typeof b.data === "object" ? b.data : {};
  const total = num(b.total_balance) ?? num(data.total_balance) ?? num(b.balance) ?? num(data.balance) ?? num(b.credits);
  if (total !== void 0) {
    const currency = typeof b.currency === "string" && b.currency || typeof data.currency === "string" && data.currency || void 0;
    return { amount: total, currency };
  }
  return null;
}
async function queryGeneric(http, opts) {
  if (!opts.url) {
    return { data: null, error: { kind: "soft", message: "No generic endpoint URL configured" } };
  }
  const headers = { Accept: "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let res;
  try {
    res = await http.request({
      url: opts.url,
      method: opts.method,
      headers,
      timeoutMs: 15e3
    });
  } catch (err) {
    return { data: null, error: { kind: "transient", message: `Network error: ${err.message}` } };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      data: null,
      error: { kind: "auth", message: `Authentication failed (HTTP ${res.status}): invalid token` }
    };
  }
  if (!res.status.toString().startsWith("2")) {
    return {
      data: null,
      error: { kind: "soft", message: `API error (HTTP ${res.status}): ${res.body.slice(0, 300)}` }
    };
  }
  let body;
  try {
    body = JSON.parse(res.body);
  } catch {
    return { data: null, error: { kind: "soft", message: "Failed to parse response as JSON" } };
  }
  const balance = parseBalance(body);
  if (balance) {
    return {
      data: {
        planKind: null,
        planType: null,
        tiers: [],
        balance
      },
      error: null
    };
  }
  const tiers = parseGenericWindows(body);
  if (tiers.length > 0) {
    return { data: { planKind: "subscription", planType: null, tiers }, error: null };
  }
  return {
    data: null,
    error: {
      kind: "soft",
      message: `Unsupported response shape: ${res.body.slice(0, 200)}`
    }
  };
}
var genericAdapter = {
  id: "generic",
  label: "Relay",
  isConfigured: (cfg) => Boolean(cfg.genericUrl.trim()),
  query: (http, cfg) => queryGeneric(http, {
    url: cfg.genericUrl,
    method: cfg.genericMethod,
    token: cfg.genericBearerToken
  })
};

// src/quota.ts
var KEEP_LAST_GOOD_MS = 10 * 60 * 1e3;
function authErrorSnapshot(platformId, platformLabel, message) {
  return {
    platformId,
    platformLabel,
    planKind: null,
    planType: null,
    tiers: [],
    balance: null,
    credentialStatus: "expired",
    error: message,
    queriedAt: Date.now(),
    success: false
  };
}
function isTransientError(message) {
  const e = message.toLowerCase();
  if (!e) return false;
  if (e.includes("network error") || e.includes("timed out") || e.includes("request failed")) {
    return true;
  }
  const httpMatch = e.match(/http\s+(\d{3})/);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    return status >= 500 && status <= 599 || status === 429;
  }
  return false;
}
function resolveDisplay(raw, prevLastGood, now) {
  let lastGood2 = prevLastGood;
  if (raw.success) {
    lastGood2 = { data: raw, at: now };
  } else if (raw.error && !isTransientError(raw.error)) {
    lastGood2 = null;
  }
  let data = raw;
  if (!raw.success && raw.error && isTransientError(raw.error) && lastGood2 && now - lastGood2.at < KEEP_LAST_GOOD_MS) {
    data = lastGood2.data;
  }
  return { data, lastGood: lastGood2 };
}
function toneForUtilization(u) {
  if (u >= 90) return "danger";
  if (u >= 70) return "warn";
  return "ok";
}

// src/service.ts
var PLUGIN_ID = "quota-monitor.claude-react-web";
var WIDGET_ID = `${PLUGIN_ID}.overview`;
var rl = readline.createInterface({ input: process.stdin });
var nextId = 1;
var pending = /* @__PURE__ */ new Map();
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function callHost(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}
var brokerHttp = {
  request: async (opts) => {
    const res = await callHost("network.fetch", {
      url: opts.url,
      method: opts.method ?? "GET",
      headers: opts.headers,
      body: opts.body,
      timeoutMs: opts.timeoutMs
    });
    return { status: res.status, headers: res.headers, body: res.body };
  }
};
var directHttp = {
  request: async (opts) => {
    const ctrl = new AbortController();
    const timer2 = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15e3);
    try {
      const res = await fetch(opts.url, {
        method: opts.method ?? "GET",
        headers: opts.headers,
        body: opts.body && opts.method === "POST" ? opts.body : void 0,
        signal: ctrl.signal
      });
      const text = await res.text();
      const headers = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return { status: res.status, headers, body: text };
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer2);
    }
  }
};
var DEFAULT_CONFIG = {
  refreshMinutes: 5,
  volcBaseUrl: "https://ark.cn-beijing.volces.com",
  volcAccessKeyId: "",
  volcSecretAccessKey: "",
  zhipuBaseUrl: "https://open.bigmodel.cn",
  zhipuApiKey: "",
  kimiApiKey: "",
  minimaxApiKey: "",
  minimaxRegion: "cn",
  zenmuxUrl: "",
  zenmuxApiKey: "",
  opencodeGoApiKey: "",
  genericName: "Relay",
  genericUrl: "",
  genericMethod: "GET",
  genericBearerToken: "",
  showWindows: []
};
var config = { ...DEFAULT_CONFIG };
function readNumber(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}
function readString(v, fallback) {
  return typeof v === "string" ? v.trim() : fallback;
}
function applyConfiguration(raw) {
  if (!raw || typeof raw !== "object") return;
  const c = raw;
  config.refreshMinutes = readNumber(c[`${PLUGIN_ID}.refreshMinutes`], DEFAULT_CONFIG.refreshMinutes);
  config.volcBaseUrl = readString(c[`${PLUGIN_ID}.volcBaseUrl`], DEFAULT_CONFIG.volcBaseUrl);
  config.volcAccessKeyId = readString(c[`${PLUGIN_ID}.volcAccessKeyId`], DEFAULT_CONFIG.volcAccessKeyId);
  config.volcSecretAccessKey = readString(c[`${PLUGIN_ID}.volcSecretAccessKey`], DEFAULT_CONFIG.volcSecretAccessKey);
  config.zhipuBaseUrl = readString(c[`${PLUGIN_ID}.zhipuBaseUrl`], DEFAULT_CONFIG.zhipuBaseUrl);
  config.zhipuApiKey = readString(c[`${PLUGIN_ID}.zhipuApiKey`], DEFAULT_CONFIG.zhipuApiKey);
  config.kimiApiKey = readString(c[`${PLUGIN_ID}.kimiApiKey`], DEFAULT_CONFIG.kimiApiKey);
  config.minimaxApiKey = readString(c[`${PLUGIN_ID}.minimaxApiKey`], DEFAULT_CONFIG.minimaxApiKey);
  const minimaxRegion = readString(c[`${PLUGIN_ID}.minimaxRegion`], DEFAULT_CONFIG.minimaxRegion);
  config.minimaxRegion = minimaxRegion === "intl" ? "intl" : "cn";
  config.zenmuxUrl = readString(c[`${PLUGIN_ID}.zenmuxUrl`], DEFAULT_CONFIG.zenmuxUrl);
  config.zenmuxApiKey = readString(c[`${PLUGIN_ID}.zenmuxApiKey`], DEFAULT_CONFIG.zenmuxApiKey);
  config.opencodeGoApiKey = readString(c[`${PLUGIN_ID}.opencodeGoApiKey`], DEFAULT_CONFIG.opencodeGoApiKey);
  config.genericName = readString(c[`${PLUGIN_ID}.genericName`], DEFAULT_CONFIG.genericName) || "Relay";
  config.genericUrl = readString(c[`${PLUGIN_ID}.genericUrl`], DEFAULT_CONFIG.genericUrl);
  config.genericBearerToken = readString(c[`${PLUGIN_ID}.genericBearerToken`], DEFAULT_CONFIG.genericBearerToken);
  const method = readString(c[`${PLUGIN_ID}.genericMethod`], DEFAULT_CONFIG.genericMethod);
  config.genericMethod = method === "POST" ? "POST" : "GET";
  const windows = c[`${PLUGIN_ID}.showWindows`];
  if (Array.isArray(windows)) {
    config.showWindows = windows.filter((w) => typeof w === "string");
  } else {
    config.showWindows = [];
  }
}
var ADAPTERS = [
  { adapter: volcengineAdapter, http: brokerHttp, tag: () => "Ark" },
  { adapter: zhipuAdapter, http: brokerHttp, tag: () => "Zhipu" },
  { adapter: kimiAdapter, http: brokerHttp, tag: () => "Kimi" },
  { adapter: minimaxAdapter, http: brokerHttp, tag: () => "MiniMax" },
  // zenmux reaches a user-configured gateway host — direct fetch like generic.
  { adapter: zenmuxAdapter, http: directHttp, tag: () => "ZenMux" },
  { adapter: opencodeGoAdapter, http: brokerHttp, tag: () => "Go" },
  {
    adapter: genericAdapter,
    http: directHttp,
    tag: () => config.genericName || "Relay"
  }
];
var latest = {};
var lastGood = {};
var polling = false;
var timer = null;
var disposed = false;
var WINDOW_ORDER = [
  { name: "five_hour", cfgKey: "fiveHour", label: "5h" },
  { name: "weekly", cfgKey: "weekly", label: "Week" },
  { name: "monthly", cfgKey: "monthly", label: "Month" },
  { name: "daily", cfgKey: "daily", label: "Day" }
];
function visibleWindowNames() {
  if (config.showWindows.length > 0) {
    return new Set(config.showWindows);
  }
  return /* @__PURE__ */ new Set(["fiveHour", "weekly", "monthly"]);
}
function formatBalance(amount, currency) {
  const rounded = Number.isFinite(amount) ? Math.round(amount * 100) / 100 : amount;
  return currency ? `${rounded} ${currency}` : String(rounded);
}
function snapshotToWidget(snaps) {
  const rows = [];
  const visible = visibleWindowNames();
  if (snaps.length === 0) {
    rows.push({ id: "status", label: "Quota", value: "Configure in settings", tone: "warn" });
  }
  for (const { snap, tag } of snaps) {
    if (!snap.success) {
      const short = snap.credentialStatus === "expired" ? "Auth error" : snap.error ? "Error" : "n/a";
      rows.push({
        id: `${snap.platformId}_status`,
        label: tag,
        value: short,
        tone: "danger"
      });
      continue;
    }
    if (snap.balance !== void 0 && snap.balance !== null) {
      rows.push({
        id: `${snap.platformId}_balance`,
        label: tag,
        value: formatBalance(snap.balance.amount, snap.balance.currency)
      });
      continue;
    }
    for (const tier of snap.tiers) {
      const order = WINDOW_ORDER.find((w) => w.name === tier.name);
      if (!order || !visible.has(order.cfgKey)) continue;
      rows.push({
        id: `${snap.platformId}_${tier.name}`,
        label: `${tag} ${order.label}`,
        value: `${Math.round(tier.utilization)}%`,
        progress: Math.min(1, Math.max(0, tier.utilization / 100)),
        tone: toneForUtilization(tier.utilization)
      });
    }
  }
  if (rows.length === 0) {
    rows.push({ id: "status", label: "Quota", value: "No data", tone: "warn" });
  }
  return { values: rows };
}
async function emitWidget() {
  const snaps = [];
  for (const { adapter, tag } of ADAPTERS) {
    const snap = latest[adapter.id];
    if (snap) snaps.push({ snap, tag: tag() });
  }
  send({
    jsonrpc: "2.0",
    method: "app.event",
    params: { widgetId: WIDGET_ID, payload: snapshotToWidget(snaps) }
  });
}
async function pollAdapter(entry) {
  const { adapter } = entry;
  if (disposed) return;
  const now = Date.now();
  if (!adapter.isConfigured(config)) {
    delete latest[adapter.id];
    delete lastGood[adapter.id];
    return;
  }
  let result;
  try {
    result = await adapter.query(entry.http, config);
  } catch (err) {
    result = {
      data: null,
      error: { kind: "soft", message: `Adapter error: ${err.message}` }
    };
  }
  let snap;
  if (result.error) {
    snap = result.error.kind === "auth" ? authErrorSnapshot(adapter.id, adapter.label, result.error.message) : {
      platformId: adapter.id,
      platformLabel: adapter.label,
      planKind: null,
      planType: null,
      tiers: [],
      balance: null,
      credentialStatus: "error",
      error: result.error.message,
      queriedAt: now,
      success: false
    };
  } else if (result.data) {
    snap = {
      platformId: adapter.id,
      platformLabel: adapter.label,
      ...result.data,
      credentialStatus: "valid",
      error: null,
      queriedAt: now,
      success: true
    };
  } else {
    snap = {
      platformId: adapter.id,
      platformLabel: adapter.label,
      planKind: null,
      planType: null,
      tiers: [],
      balance: null,
      credentialStatus: "error",
      error: "Quota API returned no data.",
      queriedAt: now,
      success: false
    };
  }
  const { data, lastGood: nextGood } = resolveDisplay(snap, lastGood[adapter.id] ?? null, now);
  latest[adapter.id] = data;
  if (nextGood) lastGood[adapter.id] = nextGood;
  else delete lastGood[adapter.id];
}
async function pollOnce() {
  if (polling || disposed) return;
  polling = true;
  try {
    await Promise.all(ADAPTERS.map((entry) => pollAdapter(entry)));
    await emitWidget();
  } catch {
  } finally {
    polling = false;
  }
}
function startPoller() {
  if (timer) clearInterval(timer);
  const minutes = config.refreshMinutes > 0 ? config.refreshMinutes : 0;
  if (minutes > 0) {
    timer = setInterval(() => {
      void pollOnce();
    }, minutes * 60 * 1e3);
  }
}
function tierTable(tiers) {
  const rows = tiers.map((t) => {
    const usedStr = t.used !== void 0 && t.quota !== void 0 ? `${t.used.toLocaleString()} / ${t.quota.toLocaleString()}` : "\u2014";
    const resetStr = t.resets_at ? new Date(t.resets_at).toLocaleString() : "\u2014";
    return `| ${t.label} | ${usedStr} | ${Math.round(t.utilization)}% | ${resetStr} |`;
  });
  return ["| Window | Used / Quota | Utilization | Resets at |", "|---|---|---|---|", ...rows].join("\n");
}
function formatSnapshotSection(snap) {
  const head = `**${snap.platformLabel}**`;
  if (!snap.success) {
    return `${head} \u2014 error: ${snap.error ?? "unknown"}`;
  }
  if (snap.balance !== void 0 && snap.balance !== null) {
    return `${head} \u2014 balance: ${formatBalance(snap.balance.amount, snap.balance.currency)}`;
  }
  const plan = snap.planKind === "agent" ? `Agent Plan (${snap.planType ?? "unknown"})` : snap.planKind === "coding" ? "Coding Plan" : snap.planKind === "subscription" ? "Subscription" : "No active plan";
  if (snap.tiers.length === 0) return `${head} \u2014 ${plan}, no windows`;
  return `${head} \u2014 ${plan}

${tierTable(snap.tiers)}`;
}
async function runCheckCommand() {
  await pollOnce();
  const configured = ADAPTERS.filter(({ adapter }) => adapter.isConfigured(config));
  if (configured.length === 0) {
    return {
      type: "dialog",
      invocationId: "",
      title: "Quota Monitor",
      content: {
        kind: "markdown",
        markdown: "No quota platforms configured. Open **Settings \u2192 App Plugins \u2192 Quota Monitor \u2192 Configuration** and fill in credentials for at least one platform (Volcengine AK/SK, Zhipu API key, Kimi API key, or a generic endpoint URL)."
      }
    };
  }
  const sections = configured.map(({ adapter }) => latest[adapter.id]).filter((s) => Boolean(s)).map(formatSnapshotSection);
  const markdown = sections.length > 0 ? `# Quota Monitor

${sections.join("\n\n")}

_Last checked ${(/* @__PURE__ */ new Date()).toLocaleString()}_` : "No quota data yet. Check again in a moment or verify your platform credentials.";
  return {
    type: "dialog",
    invocationId: "",
    title: "Quota Monitor",
    content: { kind: "markdown", markdown }
  };
}
var handlers = {
  activate: async (params) => {
    applyConfiguration(params?.configuration);
    disposed = false;
    latest = {};
    lastGood = {};
    startPoller();
    void pollOnce();
    return { ok: true };
  },
  deactivate: async () => {
    disposed = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    return { ok: true };
  },
  executeCommand: async (params) => {
    const p = params;
    const result = await runCheckCommand();
    result.invocationId = p.invocationId ?? "";
    return result;
  }
};
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || msg.jsonrpc !== "2.0") return;
  if (msg.id != null && msg.method == null) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
    return;
  }
  if (msg.method && handlers[msg.method]) {
    Promise.resolve(handlers[msg.method](msg.params)).then(
      (result) => {
        if (msg.id != null) send({ jsonrpc: "2.0", id: msg.id, result: result ?? null });
      },
      (err) => {
        if (msg.id != null) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: err.message } });
      }
    );
  }
});
