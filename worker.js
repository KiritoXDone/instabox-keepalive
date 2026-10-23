/**
 * InstaBox 机器管理面板 —— Cloudflare Worker 单文件版
 *
 * 功能：
 *   1. 可视化管理所有 InstaBox 机器（启动 / 暂停 / 唤醒 / 停止 / 删除 / 新建）
 *   2. 每台机器可独立开关「自动保活」
 *   3. Cron 定时通过 activity-leases 续期保活（租约 3600 秒，永不触发 30 分钟空闲暂停）
 *   4. 保活配置与最近 200 条日志存放在 Upstash Redis（REST 接口，纯 fetch 无依赖）
 *
 * 环境变量（在 Worker 设置中配置）：
 *   INSTABOX_API_KEY        InstaBox 的 API 密钥（ibk_ 开头）
 *   ADMIN_PASSWORD          面板登录密码
 *   UPSTASH_REDIS_REST_URL  Upstash Redis 的 REST 地址
 *   UPSTASH_REDIS_REST_TOKEN Upstash Redis 的 REST 令牌
 *
 * Cron 触发器建议每 15 分钟一次（租约 1 小时，容错充足）
 */

const API_ORIGIN = "https://api.instabox.sh";
const REDIS_PREFIX = "instabox";
const LEASE_ID = "keepalive";
const LEASE_TTL_SECONDS = 3600;      // 活动租约时长，接口上限即 3600
const LOG_KEEP = 200;                // Redis 中保留的日志条数
const REQUEST_TIMEOUT_MS = 55_000;   // 稍大于 wake/lease 接口的最长等待时间
const KEY_RE = /^ibk_[A-Za-z0-9_-]+$/;
const MACHINE_RE = /^m_[A-Za-z0-9_-]+$/;

// ---------- Upstash Redis（REST，pipeline 方式统一收发） ----------

/** 执行一组 Redis 命令，返回每条命令的结果数组；失败时整批抛错（带底层原因） */
async function redis(env, commands) {
  let res;
  try {
    res = await fetch(env.UPSTASH_REDIS_REST_URL + "/pipeline", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.UPSTASH_REDIS_REST_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    const cause = (e && (e.cause?.code || e.code)) || "";
    throw new Error((timedOut ? "Redis 请求超时" : "Redis 连接失败") + (cause ? "（" + cause + "）" : ""));
  }
  if (!res.ok) throw new Error("Redis HTTP " + res.status);
  const data = await res.json().catch(() => { throw new Error("Redis 返回了无法解析的内容"); });
  for (const item of data) {
    if (item.error) throw new Error("Redis: " + item.error);
  }
  return data.map((item) => item.result);
}

/**
 * 把 HGETALL 的结果统一成 { field: value }。
 * Upstash 的 /pipeline 接口可能返回扁平数组 [f1,v1,f2,v2,...]，也可能返回对象，
 * 两种都要兼容，否则 key 会退化成数组下标。
 */
function toHash(raw) {
  const out = {};
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) out[raw[i]] = raw[i + 1];
    return out;
  }
  if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) out[k] = v;
  }
  return out;
}

/** 读全部机器的保活配置：Hash field=machineId, value=JSON 字符串 */
async function loadConfigs(env) {
  const [raw] = await redis(env, [["HGETALL", REDIS_PREFIX + ":machines"]]);
  const out = {};
  for (const [id, json] of Object.entries(toHash(raw))) {
    try { out[id] = JSON.parse(json); } catch { /* 忽略坏数据 */ }
  }
  return out;
}

/** 写入单台机器的保活配置 */
function saveConfig(env, machineId, config) {
  return redis(env, [["HSET", REDIS_PREFIX + ":machines", machineId, JSON.stringify(config)]]);
}

/** 删除某台机器的保活配置（机器被删除时调用） */
function dropConfig(env, machineId) {
  return redis(env, [["HDEL", REDIS_PREFIX + ":machines", machineId]]);
}

/** 追加一条日志并裁剪到最近 LOG_KEEP 条 */
function addLog(env, entry) {
  return redis(env, [
    ["LPUSH", REDIS_PREFIX + ":logs", JSON.stringify(entry)],
    ["LTRIM", REDIS_PREFIX + ":logs", "0", String(LOG_KEEP - 1)],
  ]);
}

// ---------- InstaBox API ----------

/** 调用 InstaBox API；返回 { ok, status, data }，错误体自动解析出 code/message */
async function ib(env, method, path, body, idempotencyKey) {
  const headers = { "X-API-Key": env.INSTABOX_API_KEY, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  try {
    const res = await fetch((env.INSTABOX_API_ORIGIN || API_ORIGIN) + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return {
      ok: res.ok,
      status: res.status,
      data,
      code: data?.error?.code || null,
      message: data?.error?.message || null,
    };
  } catch (e) {
    // 区分超时与连接失败，并带上底层错误码（如 ENOTFOUND=域名解析失败、ECONNRESET=连接被重置）
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    const cause = (e && (e.cause?.code || e.code)) || "";
    const message = timedOut ? "请求超时" : "网络错误";
    return { ok: false, status: 0, data: null, code: "network", message: cause ? message + "（" + cause + "）" : message };
  }
}

/**
 * 给一台机器续活动租约。
 * 返回 { state: "ok" | "starting" | "failed", detail }
 */
async function renewLease(env, machineId) {
  const leasePath = "/v1/machines/" + machineId + "/activity-leases/" + LEASE_ID;
  const r = await ib(env, "PUT", leasePath, { ttlSeconds: LEASE_TTL_SECONDS });

  if (r.ok) {
    if (r.data?.machineId !== machineId || !r.data?.expiresAt) {
      return { state: "failed", detail: "接口返回的租约信息异常" };
    }
    return { state: "ok", detail: "租约至 " + r.data.expiresAt, expiresAt: r.data.expiresAt };
  }

  // 机器处于 stopped（而非空闲暂停）时租约接口会拒绝，此时尝试重新启动
  if (r.status === 409) {
    const s = await ib(env, "POST", "/v1/machines/" + machineId + "/start", undefined, crypto.randomUUID());
    if (s.ok) return { state: "starting", detail: "机器未运行，已下发启动指令" };
    return { state: "failed", detail: "启动失败：HTTP " + s.status + (s.code ? " " + s.code : "") };
  }

  return { state: "failed", detail: "HTTP " + r.status + (r.code ? " " + r.code : "") };
}

/** 立即保活一台机器并把结果写入配置与日志（面板开关打开时也会调用一次） */
async function keepAliveOnce(env, machineId, name) {
  const configs = await loadConfigs(env);
  const config = configs[machineId] || {};
  const result = await renewLease(env, machineId);
  const now = new Date().toISOString();
  await saveConfig(env, machineId, {
    ...config,
    keepalive: "on",
    lastStatus: result.state,
    lastDetail: result.detail,
    leaseExpiresAt: result.expiresAt || null,
    lastAt: now,
  });
  await addLog(env, { t: now, machineId, name: name || machineId, action: "保活", ok: result.state !== "failed", detail: result.detail });
  return result;
}

// ---------- 鉴权与路由 ----------

/** 校验面板密码：所有 /api 请求都必须带 X-Panel-Auth 头 */
function authorized(request, env) {
  const provided = request.headers.get("X-Panel-Auth") || "";
  const expected = env.ADMIN_PASSWORD || "";
  return expected.length > 0 && provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** 恒时字符串比较，避免时序侧信道 */
function timingSafeEqual(a, b) {
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** 处理面板的全部 API 请求 */
async function handleApi(request, env, url) {
  if (!authorized(request, env)) return json({ error: "未登录或密码错误" }, 401);
  const path = url.pathname.replace(/^\/api/, "");
  const method = request.method;

  // 登录校验
  if (path === "/auth" && method === "POST") return json({ ok: true });

  // 机器列表：InstaBox 实时状态 + Redis 保活配置合并
  // Redis 读取失败不影响机器列表展示，只把保活状态标为未知
  if (path === "/machines" && method === "GET") {
    const list = await ib(env, "GET", "/v1/machines");
    if (!list.ok) return json({ error: "获取机器列表失败：" + (list.message || list.status) }, 502);
    let configs = {};
    let configError = null;
    try {
      configs = await loadConfigs(env);
    } catch (e) {
      configError = e.message;
    }
    const machines = (list.data?.machines || []).map((m) => ({
      id: m.id,
      name: m.name,
      state: m.state,
      spec: m.spec,
      template: m.template?.id || null,
      guestUser: m.guestUser || null,
      autoSuspendAfterSeconds: m.autoSuspendAfterSeconds ?? null,
      keepalive: configs[m.id] || null,
    }));
    return json({ machines, configError });
  }

  // 机器生命周期操作与删除
  const lifecycleMatch = path.match(/^\/machines\/([^/]+)\/(start|stop|suspend|resume)$/);
  if (lifecycleMatch && method === "POST") {
    const [, id, action] = lifecycleMatch;
    if (!MACHINE_RE.test(id) && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) return json({ error: "机器 ID 不合法" }, 400);
    const input = await request.json().catch(() => ({}));
    const label = typeof input.name === "string" && input.name ? input.name : id;
    const ACTION_LABEL = { start: "启动", stop: "停止", suspend: "暂停", resume: "唤醒" };
    const r = await ib(env, "POST", "/v1/machines/" + id + "/" + action, undefined, crypto.randomUUID());
    if (!r.ok) {
      await addLog(env, { t: new Date().toISOString(), machineId: id, name: label, action: ACTION_LABEL[action], ok: false, detail: "下发失败：" + (r.message || r.status) }).catch(() => {});
      return json({ error: (action + " 失败：") + (r.message || r.status) }, 502);
    }
    // 记录实际下发的动作，便于事后核对是暂停还是停止
    await addLog(env, { t: new Date().toISOString(), machineId: id, name: label, action: ACTION_LABEL[action], ok: true, detail: "指令已下发（" + action + "）" }).catch(() => {});
    // 手动停止/暂停时自动关掉保活，避免下一轮 Cron 又把机器拉起来
    if (action === "stop" || action === "suspend") {
      const configs = await loadConfigs(env);
      if (configs[id]?.keepalive === "on") {
        await saveConfig(env, id, { ...configs[id], keepalive: "off", lastDetail: "手动" + ACTION_LABEL[action] + "，保活已关闭" });
        await addLog(env, { t: new Date().toISOString(), machineId: id, name: label, action: "保活", ok: true, detail: "手动" + ACTION_LABEL[action] + "，自动关闭保活" });
      }
    }
    return json({ ok: true, operationId: r.data?.operationId || r.data?.id || null }, 202);
  }

  const deleteMatch = path.match(/^\/machines\/([^/]+)$/);
  if (deleteMatch && method === "DELETE") {
    const id = deleteMatch[1];
    const r = await ib(env, "DELETE", "/v1/machines/" + id);
    if (!r.ok) return json({ error: "删除失败：" + (r.message || r.status) }, 502);
    await dropConfig(env, id).catch(() => {});
    await addLog(env, { t: new Date().toISOString(), machineId: id, name: id, action: "删除", ok: true, detail: "机器已删除，保活配置已清理" });
    return json({ ok: true, operationId: r.data?.operationId || r.data?.id || null }, 202);
  }

  // 保活开关：打开时立即续一次租约，关闭时仅写配置
  const keepaliveMatch = path.match(/^\/machines\/([^/]+)\/keepalive$/);
  if (keepaliveMatch && method === "POST") {
    const id = keepaliveMatch[1];
    const input = await request.json().catch(() => ({}));
    const enable = !!input.enable;
    const configs = await loadConfigs(env);
    const config = configs[id] || {};
    if (enable) {
      // 保活配置在续期之前就已写入，因此首次续期失败也算「已开启」，
      // 由定时任务继续重试，这里只把失败原因作为警告返回，避免前端把开关回滚掉
      const result = await keepAliveOnce(env, id, input.name);
      const warning = result.state === "failed"
        ? "保活已开启，但首次续期失败：" + result.detail + "（定时任务会继续重试）"
        : null;
      return json({ ok: true, detail: result.detail, warning });
    }
    await saveConfig(env, id, { ...config, keepalive: "off", lastDetail: "保活已手动关闭", lastAt: new Date().toISOString() });
    await addLog(env, { t: new Date().toISOString(), machineId: id, name: input.name || id, action: "保活", ok: true, detail: "保活已关闭" });
    return json({ ok: true });
  }

  // 日志
  if (path === "/logs" && method === "GET") {
    const [logs] = await redis(env, [["LRANGE", REDIS_PREFIX + ":logs", "0", "49"]]);
    return json({ logs: (logs || []).map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean) });
  }
  // 清空日志：只删日志，不动保活配置
  if (path === "/logs" && method === "DELETE") {
    await redis(env, [["DEL", REDIS_PREFIX + ":logs"]]);
    return json({ ok: true });
  }

  // 配额
  if (path === "/usage" && method === "GET") {
    const r = await ib(env, "GET", "/v1/usage");
    return json({ usage: r.ok ? r.data : null });
  }

  return json({ error: "接口不存在" }, 404);
}

// ---------- Cron 保活任务 ----------

/** 每 15 分钟执行：对所有开启保活的机器续租约，异常时尝试拉起 */
async function runKeepaliveTick(env) {
  if (!env.INSTABOX_API_KEY || !KEY_RE.test(env.INSTABOX_API_KEY)) throw new Error("未配置有效的 INSTABOX_API_KEY");
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) throw new Error("未配置 Upstash Redis");

  const configs = await loadConfigs(env);
  const targets = Object.entries(configs).filter(([, c]) => c.keepalive === "on");
  if (targets.length === 0) return { renewed: 0 };

  let renewed = 0;
  for (const [machineId, config] of targets) {
    const result = await renewLease(env, machineId);
    const now = new Date().toISOString();
    await saveConfig(env, machineId, {
      ...config,
      lastStatus: result.state,
      lastDetail: result.detail,
      leaseExpiresAt: result.expiresAt || null,
      lastAt: now,
    });
    await addLog(env, { t: now, machineId, name: config.name || machineId, action: "自动保活", ok: result.state !== "failed", detail: result.detail });
    if (result.state !== "failed") renewed++;
  }
  return { renewed, total: targets.length };
}

// ---------- Worker 入口 ----------

export default {
  async fetch(request, env) {
    // 兜底：任何未预期的异常都以 JSON 返回，避免裸 500 页面
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api")) return await handleApi(request, env, url);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(renderPage(), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      return json({ error: "服务器内部错误：" + ((e && e.message) || e) }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    try {
      const result = await runKeepaliveTick(env);
      console.log(JSON.stringify({ event: "keepalive_tick_ok", ...result }));
    } catch (error) {
      console.error(JSON.stringify({ event: "keepalive_tick_failed", message: error.message }));
    }
  },
};

// ---------- 前端面板（单页 HTML，内嵌样式与脚本） ----------

function renderPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>InstaBox 控制台</title>
<style>
  :root {
    --bg: #f5f5f7;
    --card: #ffffff;
    --text: #1d1d1f;
    --muted: #86868b;
    --line: #e8e8ed;
    --blue: #0071e3;
    --green: #34c759;
    --orange: #ff9500;
    --red: #ff3b30;
    --gray: #8e8e93;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; -webkit-font-smoothing: antialiased; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 15px;
    line-height: 1.5;
    min-height: 100vh;
  }
  h1, h2 { font-weight: 600; letter-spacing: -0.01em; }

  /* ---------- 登录 ---------- */
  .login-wrap { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
  .login-card {
    width: 100%; max-width: 360px; background: var(--card); border-radius: 22px;
    padding: 36px 32px; text-align: center;
    box-shadow: 0 2px 8px rgba(0,0,0,.04), 0 20px 50px rgba(0,0,0,.08);
  }
  .logo {
    width: 56px; height: 56px; margin: 0 auto 18px; border-radius: 16px;
    background: linear-gradient(160deg, #0a84ff, #0055c4);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 22px; font-weight: 700; letter-spacing: -0.5px;
    box-shadow: 0 6px 18px rgba(0,113,227,.3);
  }
  .login-card h1 { font-size: 24px; margin-bottom: 4px; }
  .login-card .sub { color: var(--muted); font-size: 13px; margin-bottom: 26px; }
  .field {
    width: 100%; font: inherit; font-size: 15px; color: var(--text);
    background: rgba(120,120,128,.08); border: 1px solid transparent;
    border-radius: 12px; padding: 12px 14px; outline: none;
    transition: border-color .2s, background .2s;
  }
  .field:focus { background: #fff; border-color: var(--blue); }
  .field::placeholder { color: var(--muted); }

  /* ---------- 按钮 ---------- */
  .btn {
    font: inherit; font-size: 13px; font-weight: 500; letter-spacing: 0;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    min-height: 32px; padding: 7px 16px; border: none; border-radius: 980px;
    background: rgba(0,0,0,.05); color: var(--text); cursor: pointer;
    transition: background .2s ease, transform .1s ease, opacity .2s ease;
    white-space: nowrap; user-select: none;
  }
  .btn:hover:not(:disabled) { background: rgba(0,0,0,.08); }
  .btn:active:not(:disabled) { transform: scale(.97); }
  .btn:disabled { opacity: .45; cursor: default; }
  .btn.primary { background: var(--blue); color: #fff; }
  .btn.primary:hover:not(:disabled) { background: #0077ed; }
  .btn.danger { color: var(--red); background: rgba(255,59,48,.07); }
  .btn.danger:hover:not(:disabled) { background: rgba(255,59,48,.12); }
  .btn.block { width: 100%; min-height: 44px; font-size: 15px; margin-top: 16px; }

  .spinner {
    width: 13px; height: 13px; border-radius: 50%;
    border: 2px solid currentColor; border-top-color: transparent;
    animation: spin .7s linear infinite; display: inline-block;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ---------- 顶栏 ---------- */
  .topbar {
    position: sticky; top: 0; z-index: 5;
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 12px 24px; flex-wrap: wrap;
    background: rgba(245,245,247,.75);
    backdrop-filter: saturate(180%) blur(20px);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    border-bottom: 1px solid rgba(0,0,0,.06);
  }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand .mark {
    width: 28px; height: 28px; border-radius: 8px;
    background: linear-gradient(160deg, #0a84ff, #0055c4);
    color: #fff; font-size: 12px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
  }
  .brand h1 { font-size: 17px; }
  .top-right { display: flex; align-items: center; gap: 12px; }
  .quota { color: var(--muted); font-size: 12.5px; }

  /* 分段导航 */
  .tabs {
    display: flex; gap: 2px; padding: 3px;
    background: rgba(120,120,128,.12); border-radius: 10px;
  }
  .tabs button {
    font: inherit; font-size: 13px; font-weight: 500;
    padding: 5px 20px; border: none; border-radius: 8px;
    background: transparent; color: var(--text); cursor: pointer;
    transition: background .2s ease, box-shadow .2s ease;
  }
  .tabs button.active {
    background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.1), 0 0 1px rgba(0,0,0,.06);
  }

  main { max-width: 1120px; margin: 0 auto; padding: 22px 24px 60px; }

  /* ---------- 机器卡片 ---------- */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 16px; }
  .card {
    background: var(--card); border-radius: 18px; padding: 20px;
    box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 6px 18px rgba(0,0,0,.045);
    transition: box-shadow .25s ease, transform .25s ease;
  }
  .card:hover { box-shadow: 0 2px 6px rgba(0,0,0,.06), 0 14px 32px rgba(0,0,0,.08); transform: translateY(-1px); }
  /* 操作进行中：整张卡片锁定，避免并发下发互相冲突 */
  .card.locked { opacity: .55; pointer-events: none; }
  .card-head { margin-bottom: 14px; }
  .card-head-top {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; margin-bottom: 7px;
  }
  .card-title {
    font-size: 17px; font-weight: 600; letter-spacing: -0.01em;
    word-break: break-all; min-width: 0;
  }
  .card-meta { color: var(--muted); font-size: 12px; line-height: 1.7; word-break: break-all; }
  .card-meta .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }

  .pill {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 12px; font-weight: 500; padding: 3px 10px; border-radius: 980px;
    white-space: nowrap; flex-shrink: 0;
  }
  .pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .pill.running { background: rgba(52,199,89,.12); color: #248a3d; }
  .pill.suspended { background: rgba(255,149,0,.14); color: #b25000; }
  .pill.stopped { background: rgba(142,142,147,.14); color: #6e6e73; }
  .pill.error { background: rgba(255,59,48,.12); color: #c4281c; }
  .pill.busy { background: rgba(0,113,227,.12); color: #0060c0; }

  .actions { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 14px; }
  .hint { color: var(--muted); font-size: 11px; line-height: 1.6; margin: -6px 0 14px; }

  .keepalive {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 14px;
    padding-top: 14px; border-top: 1px solid var(--line);
  }
  .ka-body { min-width: 0; flex: 1; }
  .keepalive .label { font-size: 13px; font-weight: 500; margin-bottom: 6px; }
  .time-row {
    display: flex; justify-content: space-between; gap: 10px;
    font-size: 11.5px; color: var(--muted); line-height: 1.8;
  }
  .time-row b {
    font-weight: 500; color: var(--text); white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px; font-variant-numeric: tabular-nums;
  }
  .keepalive .state { color: var(--muted); font-size: 11.5px; margin-top: 4px; line-height: 1.5; }
  .keepalive .state.active { color: #248a3d; }

  .switch {
    width: 51px; height: 31px; border-radius: 16px; border: none; padding: 0;
    background: rgba(120,120,128,.16); position: relative; cursor: pointer;
    transition: background .25s ease; flex-shrink: 0;
  }
  .switch::after {
    content: ""; position: absolute; top: 2px; left: 2px;
    width: 27px; height: 27px; border-radius: 50%; background: #fff;
    box-shadow: 0 3px 8px rgba(0,0,0,.15), 0 1px 1px rgba(0,0,0,.06);
    transition: transform .25s cubic-bezier(.4,0,.2,1);
  }
  .switch.on { background: var(--green); }
  .switch.on::after { transform: translateX(20px); }
  .switch:disabled { opacity: .55; cursor: default; }

  /* ---------- 日志 ---------- */
  .logs-card {
    background: var(--card); border-radius: 18px; padding: 20px; margin-top: 18px;
    box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 6px 18px rgba(0,0,0,.045);
  }
  .logs-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
  .logs-head h2 { font-size: 15px; }
  .logs-head .muted { color: var(--muted); font-size: 11.5px; }
  .log-list { max-height: 300px; overflow-y: auto; }
  #logsView .logs-card { margin-top: 0; }
  .log-list.tall { max-height: calc(100vh - 250px); }
  .log-item {
    display: flex; align-items: baseline; gap: 10px;
    padding: 9px 0; border-bottom: 1px solid var(--line);
    font-size: 12.5px; color: var(--muted);
  }
  .log-item:last-child { border-bottom: none; }
  .log-item .time { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; flex-shrink: 0; color: var(--gray); }
  .log-item .who { color: var(--text); font-weight: 500; flex-shrink: 0; }
  .log-item .what { color: var(--muted); word-break: break-all; }
  .log-item.fail .what { color: #c4281c; }

  .empty {
    text-align: center; color: var(--muted); font-size: 13.5px;
    padding: 56px 20px; background: var(--card); border-radius: 18px;
  }
  .notice {
    display: none; background: rgba(255,149,0,.1); color: #8a4500;
    border-radius: 12px; padding: 10px 14px; font-size: 12.5px; margin-bottom: 16px;
  }
  .notice.show { display: block; }

  /* ---------- 加载骨架 ---------- */
  .skeleton {
    background: var(--card); border-radius: 18px; padding: 20px;
    box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 6px 18px rgba(0,0,0,.045);
  }
  .sk-line {
    height: 12px; border-radius: 6px; margin-bottom: 10px;
    background: linear-gradient(90deg, #ededf1 25%, #f6f6f8 50%, #ededf1 75%);
    background-size: 200% 100%;
    animation: shimmer 1.3s ease-in-out infinite;
  }
  @keyframes shimmer { to { background-position: -200% 0; } }

  /* ---------- 确认弹窗 ---------- */
  .modal-mask {
    position: fixed; inset: 0; z-index: 30;
    display: flex; align-items: center; justify-content: center; padding: 20px;
    background: rgba(0,0,0,.32); backdrop-filter: blur(4px);
    opacity: 0; pointer-events: none; transition: opacity .2s ease;
  }
  .modal-mask.show { opacity: 1; pointer-events: auto; }
  .modal {
    width: 100%; max-width: 340px; background: #fff; border-radius: 18px;
    padding: 22px; text-align: center;
    box-shadow: 0 20px 60px rgba(0,0,0,.22);
    transform: scale(.94); transition: transform .22s cubic-bezier(.4,0,.2,1);
  }
  .modal-mask.show .modal { transform: scale(1); }
  .modal h3 { font-size: 16px; margin-bottom: 8px; letter-spacing: -0.01em; }
  .modal p { color: var(--muted); font-size: 13px; line-height: 1.6; margin-bottom: 20px; }
  .modal-actions { display: flex; gap: 8px; }
  .modal-actions .btn { flex: 1; min-height: 40px; font-size: 14px; }
  .btn.danger-solid { background: var(--red); color: #fff; }
  .btn.danger-solid:hover:not(:disabled) { background: #e0352b; }

  .logs-head .tools { display: flex; align-items: center; gap: 10px; }
  .logs-head .btn { min-height: 26px; padding: 3px 11px; font-size: 11.5px; }

  .toast {
    position: fixed; left: 50%; bottom: 28px; transform: translate(-50%, 12px);
    background: rgba(29,29,31,.92); color: #fff; font-size: 13px;
    padding: 10px 18px; border-radius: 980px; opacity: 0; pointer-events: none;
    transition: opacity .22s ease, transform .22s ease; z-index: 20;
    max-width: 86vw; text-align: center;
    backdrop-filter: blur(10px);
  }
  .toast.show { opacity: 1; transform: translate(-50%, 0); }
  .toast.err { background: rgba(196,40,28,.95); }

  @media (max-width: 640px) {
    .topbar { padding: 10px 16px; }
    main { padding: 16px 16px 40px; }
    .grid { grid-template-columns: 1fr; }
    .quota { display: none; }
  }
</style>
</head>
<body>

<div id="loginView" class="login-wrap" style="display:none">
  <div class="login-card">
    <div class="logo">IB</div>
    <h1>InstaBox</h1>
    <p class="sub">机器控制台</p>
    <input id="pwd" class="field" type="password" placeholder="面板密码" autocomplete="current-password">
    <button id="loginBtn" class="btn primary block">登录</button>
  </div>
</div>

<div id="mainView" style="display:none">
  <header class="topbar">
    <div class="brand"><span class="mark">IB</span><h1>InstaBox</h1></div>
    <nav class="tabs">
      <button data-tab="machines" class="active">机器</button>
      <button data-tab="logs">日志</button>
    </nav>
    <div class="top-right">
      <span class="quota" id="quota"></span>
      <button id="refreshBtn" class="btn">刷新</button>
      <button id="logoutBtn" class="btn">退出</button>
    </div>
  </header>
  <main>
    <div id="notice" class="notice"></div>
    <section id="machinesView">
      <div class="grid" id="machines"></div>
    </section>
    <section id="logsView" style="display:none">
      <div class="logs-card">
        <div class="logs-head">
          <h2>保活日志</h2>
          <div class="tools">
            <span class="muted">最近 50 条 · 存于 Upstash Redis</span>
            <button id="clearLogsBtn" class="btn danger">清空</button>
          </div>
        </div>
        <div id="logList" class="log-list tall"></div>
      </div>
    </section>
  </main>
</div>

<div id="confirmMask" class="modal-mask">
  <div class="modal">
    <h3 id="cfTitle"></h3>
    <p id="cfMsg"></p>
    <div class="modal-actions">
      <button id="cfCancel" class="btn">取消</button>
      <button id="cfOk" class="btn primary">确定</button>
    </div>
  </div>
</div>

<div id="toast" class="toast"></div>

<script>
"use strict";

var AUTH = localStorage.getItem("ib_auth") || "";
var DATA = { machines: [], logs: [], usage: null };
var BUSY = {};            // 防重复点击：按操作维度加锁
var MACHINE_BUSY = {};    // 按机器加锁：一台机器操作中，卡片内所有按钮一并禁用
var toastTimer = null;

/** 目标状态映射：下发指令后先把卡片切到过渡态，界面立刻有反馈 */
var OPTIMISTIC = { start: "starting", resume: "resuming", suspend: "suspending", stop: "stopping" };

var STATE_TEXT = {
  creating: "创建中", starting: "启动中", running: "运行中", stopping: "停止中",
  stopped: "已停止", suspending: "暂停中", suspended: "已暂停", resuming: "恢复中",
  deleting: "删除中", error: "异常"
};
var STATE_PILL = {
  running: "running", suspended: "suspended", stopped: "stopped", error: "error",
  creating: "busy", starting: "busy", stopping: "busy", suspending: "busy",
  resuming: "busy", deleting: "busy"
};
var ACTION_TEXT = { start: "启动", resume: "唤醒", suspend: "暂停", stop: "停止" };

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}
var CRON_MINUTES = 15;   // 与 wrangler.toml 里的定时任务间隔保持一致

/** 统一按中国时间（UTC+8）输出 xxxx-xx-xx xx:xx:xx，不受浏览器所在时区影响 */
function fmtCN(iso) {
  if (!iso) return "—";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  var parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(d);
  var o = {};
  for (var i = 0; i < parts.length; i++) o[parts[i].type] = parts[i].value;
  return o.year + "-" + o.month + "-" + o.day + " " + o.hour + ":" + o.minute + ":" + o.second;
}

/** 下一次保活时间：按定时任务的整刻边界推算 */
function nextTickAt(fromIso) {
  var base = fromIso ? new Date(fromIso).getTime() : Date.now();
  if (isNaN(base)) base = Date.now();
  var step = CRON_MINUTES * 60 * 1000;
  return new Date(Math.ceil(base / step) * step).toISOString();
}

function remainText(iso) {
  if (!iso) return "";
  var ms = new Date(iso).getTime() - Date.now();
  if (isNaN(ms)) return "";
  if (ms <= 0) return "租约已过期";
  var min = Math.round(ms / 60000);
  return "租约剩余 " + (min >= 60 ? Math.floor(min / 60) + " 小时 " + (min % 60) + " 分" : min + " 分钟");
}

/** 把文本里的 ISO 时间戳换成中国时间，日志详情更易读 */
function humanize(text) {
  return String(text == null ? "" : text).replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g,
    function (m) { return fmtCN(m); }
  );
}

/** 通用确认弹窗，返回 Promise<boolean> */
function confirmDialog(opts) {
  return new Promise(function (resolve) {
    var mask = document.getElementById("confirmMask");
    var okBtn = document.getElementById("cfOk");
    var cancelBtn = document.getElementById("cfCancel");

    document.getElementById("cfTitle").textContent = opts.title || "确认操作";
    document.getElementById("cfMsg").textContent = opts.message || "";
    okBtn.textContent = opts.okText || "确定";
    okBtn.className = "btn " + (opts.danger ? "danger-solid" : "primary");
    mask.classList.add("show");

    function finish(value) {
      mask.classList.remove("show");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      mask.removeEventListener("click", onMask);
      resolve(value);
    }
    function onOk() { finish(true); }
    function onCancel() { finish(false); }
    function onMask(e) { if (e.target === mask) finish(false); }

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    mask.addEventListener("click", onMask);
  });
}

function toast(msg, isErr) {
  var el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.className = "toast" + (isErr ? " err" : ""); }, 3400);
}

/** 统一的 API 封装：附带面板密码，非 2xx 抛错并带上服务端原因 */
function api(path, options) {
  options = options || {};
  options.headers = Object.assign({ "X-Panel-Auth": AUTH, "Content-Type": "application/json" }, options.headers || {});
  return fetch("/api" + path, options).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (res.status === 401) { logout(); throw new Error("登录已失效，请重新登录"); }
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      return data;
    });
  });
}

/** 锁定整张卡片：操作进行中，其他按钮与开关都不可点 */
function setMachineLocked(id, locked) {
  if (locked) MACHINE_BUSY[id] = true;
  else delete MACHINE_BUSY[id];
  var card = document.querySelector('[data-card="' + id + '"]');
  if (!card) return;
  card.classList.toggle("locked", locked);
  var els = card.querySelectorAll("button");
  for (var i = 0; i < els.length; i++) els[i].disabled = locked;
}

/** 按钮忙碌态：锁定宽度避免跳动，显示转圈，结束后恢复原文案 */
function setBtnBusy(btn, isBusy) {
  if (!btn) return;
  if (isBusy) {
    if (btn.dataset.text == null) btn.dataset.text = btn.textContent;
    if (!btn.style.width) btn.style.width = btn.offsetWidth + "px";
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
  } else {
    btn.disabled = false;
    btn.textContent = btn.dataset.text || btn.textContent;
    btn.style.width = "";
  }
}

// ---------- 登录 ----------
function showLogin() {
  document.getElementById("loginView").style.display = "flex";
  document.getElementById("mainView").style.display = "none";
  setTimeout(function () { document.getElementById("pwd").focus(); }, 60);
}
function showMain() {
  document.getElementById("loginView").style.display = "none";
  document.getElementById("mainView").style.display = "block";
  // 重新登录后清掉可能残留的忙碌态
  setBtnBusy(document.getElementById("refreshBtn"), false);
  setBtnBusy(document.getElementById("clearLogsBtn"), false);
  switchTab(localStorage.getItem("ib_tab") || "machines", true);
  loadAll();
}

/** 切换「机器 / 日志」视图；切到日志时顺手刷新一次数据 */
function switchTab(name, skipReload) {
  var isMachines = name !== "logs";
  document.getElementById("machinesView").style.display = isMachines ? "" : "none";
  document.getElementById("logsView").style.display = isMachines ? "none" : "";
  var tabs = document.querySelectorAll("[data-tab]");
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle("active", tabs[i].getAttribute("data-tab") === (isMachines ? "machines" : "logs"));
  }
  try { localStorage.setItem("ib_tab", isMachines ? "machines" : "logs"); } catch (e) { /* 忽略隐私模式限制 */ }
  if (!isMachines && !skipReload) loadAll();
}
function logout() {
  localStorage.removeItem("ib_auth");
  AUTH = "";
  showLogin();
}
function login() {
  var btn = document.getElementById("loginBtn");
  var pwd = document.getElementById("pwd").value.trim();
  if (!pwd) { toast("请输入密码", true); return; }
  if (btn.disabled) return;
  AUTH = pwd;
  setBtnBusy(btn, true);
  api("/auth", { method: "POST" })
    .then(function () {
      localStorage.setItem("ib_auth", AUTH);
      document.getElementById("pwd").value = "";
      showMain();
    })
    .catch(function (e) { AUTH = ""; toast("登录失败：" + e.message, true); })
    .then(function () { setBtnBusy(btn, false); });
}

// ---------- 数据加载 ----------
var firstLoad = true;

/** 加载骨架：仅在还没有数据时展示，避免刷新时画面闪烁 */
function renderSkeleton() {
  var box = document.getElementById("machines");
  var one = '<div class="skeleton">' +
    '<div class="sk-line" style="width:42%;height:16px"></div>' +
    '<div class="sk-line" style="width:68%"></div>' +
    '<div class="sk-line" style="width:52%"></div>' +
    '<div class="sk-line" style="width:34%;margin-top:20px"></div>' +
    '</div>';
  box.innerHTML = one + one + one;
}

/** 三个请求互相独立：任一失败不影响其余内容渲染 */
function loadAll() {
  if (firstLoad) renderSkeleton();
  return Promise.allSettled([api("/machines"), api("/logs"), api("/usage")]).then(function (results) {
    firstLoad = false;
    var problems = [];

    if (results[0].status === "fulfilled") {
      DATA.machines = results[0].value.machines || [];
      if (results[0].value.configError) problems.push("保活配置读取失败：" + results[0].value.configError);
    } else {
      problems.push(results[0].reason.message);
    }
    if (results[1].status === "fulfilled") DATA.logs = results[1].value.logs || [];
    else problems.push("日志加载失败：" + results[1].reason.message);
    if (results[2].status === "fulfilled") DATA.usage = results[2].value.usage;
    else problems.push("配额加载失败：" + results[2].reason.message);

    render();

    var notice = document.getElementById("notice");
    if (problems.length) {
      notice.textContent = problems.join("；");
      notice.className = "notice show";
    } else {
      notice.className = "notice";
    }
    return problems;
  });
}

/** 操作下发后自动追状态：过渡态期间再多刷几次，直到稳定 */
var PENDING_RE = /^(creating|starting|stopping|suspending|resuming|deleting)$/;
function followUp(rounds) {
  var left = typeof rounds === "number" ? rounds : 3;
  // 首次很快，之后逐步放慢，避免频繁打接口
  var wait = left >= 3 ? 800 : 2000;
  return delay(wait).then(function () {
    return loadAll().then(function () {
      var pending = false;
      for (var i = 0; i < DATA.machines.length; i++) {
        if (PENDING_RE.test(DATA.machines[i].state)) { pending = true; break; }
      }
      if (pending && left > 0) return followUp(left - 1);
    });
  });
}

/** 按 ID 找当前列表里的机器 */
function findMachine(id) {
  for (var i = 0; i < DATA.machines.length; i++) {
    if (DATA.machines[i].id === id) return DATA.machines[i];
  }
  return null;
}

// ---------- 渲染 ----------
function render() {
  var u = DATA.usage || {};
  var parts = [];
  if (u.machines != null) parts.push("机器 " + u.machines);
  if (u.snapshots != null) parts.push("快照 " + u.snapshots);
  if (u.storageGiB != null) parts.push("存储 " + u.storageGiB + " GB");
  document.getElementById("quota").textContent = parts.join(" · ");

  var box = document.getElementById("machines");
  if (!DATA.machines.length) {
    box.innerHTML = '<div class="empty">暂无机器</div>';
  } else {
    box.innerHTML = DATA.machines.map(renderCard).join("");
  }

  var list = document.getElementById("logList");
  if (!DATA.logs.length) {
    list.innerHTML = '<div class="log-item"><span class="what">暂无日志</span></div>';
  } else {
    list.innerHTML = DATA.logs.map(function (l) {
      return '<div class="log-item' + (l.ok ? "" : " fail") + '">' +
        '<span class="time">' + esc(fmtCN(l.t)) + '</span>' +
        '<span class="who">' + esc(l.name || l.machineId) + '</span>' +
        '<span class="what">' + esc(l.action) + ' · ' + esc(humanize(l.detail)) + '</span>' +
        '</div>';
    }).join("");
  }
}

function renderCard(m) {
  var ka = m.keepalive || {};
  var on = ka.keepalive === "on";
  var stateText = STATE_TEXT[m.state] || m.state;
  var pillClass = STATE_PILL[m.state] || "busy";

  // 保活状态：上次 / 下次保活时间 + 租约剩余
  var timeRows = "";
  if (ka.lastAt) {
    timeRows += '<div class="time-row"><span>上次保活</span><b>' + esc(fmtCN(ka.lastAt)) + '</b></div>';
  }
  if (on) {
    timeRows += '<div class="time-row"><span>下次保活</span><b>' + esc(fmtCN(nextTickAt(ka.lastAt))) + '</b></div>';
  }

  var stateLine;
  var stateClass = "";
  if (on) {
    stateLine = remainText(ka.leaseExpiresAt);
    stateClass = " active";
  } else if (ka.lastAt) {
    stateLine = "已关闭 · " + (ka.lastDetail || "");
  } else {
    stateLine = "未开启";
  }

  // 按当前状态给出可用操作；卡片被锁定时全部禁用
  var locked = !!MACHINE_BUSY[m.id];
  var dis = locked ? " disabled" : "";
  var acts = [];
  if (m.state === "suspended") acts.push(["resume", "唤醒"]);
  if (m.state === "stopped") acts.push(["start", "启动"]);
  if (m.state === "running") { acts.push(["suspend", "暂停"]); acts.push(["stop", "停止"]); }

  var btns = acts.map(function (a) {
    return '<button class="btn" data-act="' + a[0] + '" data-id="' + esc(m.id) + '"' + dis + '>' + a[1] + '</button>';
  }).join("");
  btns += '<button class="btn danger" data-del="' + esc(m.id) + '" data-name="' + esc(m.name) + '"' + dis + '>删除</button>';

  var spec = "";
  if (m.spec) {
    spec = m.spec.vcpus + " 核 · " + Math.round(m.spec.memMiB / 1024) + " GB 内存" +
      (m.spec.persistentDiskGiB ? " · " + m.spec.persistentDiskGiB + " GB 磁盘" : "");
  }

  return '<div class="card' + (locked ? " locked" : "") + '" data-card="' + esc(m.id) + '">' +
    '<div class="card-head">' +
      '<div class="card-head-top">' +
        '<div class="card-title">' + esc(m.name) + '</div>' +
        '<span class="pill ' + pillClass + '">' + esc(stateText) + '</span>' +
      '</div>' +
      '<div class="card-meta"><span class="mono">' + esc(m.id) + '</span><br>' +
      esc(spec) + (m.template ? " · " + esc(m.template) : "") + '</div>' +
    '</div>' +
    '<div class="actions">' + btns + '</div>' +
    (m.state === "running" ? '<div class="hint">暂停保留内存与进程，可原地继续；停止等于关机，只保留文件。</div>' : "") +
    '<div class="keepalive">' +
      '<div class="ka-body">' +
        '<div class="label">自动保活</div>' +
        timeRows +
        '<div class="state' + stateClass + '">' + esc(stateLine) + '</div>' +
      '</div>' +
      '<button class="switch' + (on ? " on" : "") + '" data-toggle="' + esc(m.id) + '" aria-pressed="' + (on ? "true" : "false") + '" aria-label="自动保活"' + dis + '></button>' +
    '</div>' +
  '</div>';
}

// ---------- 操作 ----------
function lifecycle(id, action, btn) {
  var key = "act:" + id + ":" + action;
  if (BUSY[key] || MACHINE_BUSY[id]) return;

  var run = function () {
    var m = findMachine(id);
    var label = m ? m.name : id;
    BUSY[key] = true;
    setMachineLocked(id, true);
    setBtnBusy(btn, true);
    api("/machines/" + id + "/" + action, { method: "POST", body: JSON.stringify({ name: label }) })
      .then(function () {
        // 先把本地状态切到过渡态，界面立刻有反馈，不必等下一次轮询
        var current = findMachine(id);
        if (current && OPTIMISTIC[action]) {
          current.state = OPTIMISTIC[action];
          render();
        }
        toast("已下发" + ACTION_TEXT[action] + "指令 · " + label);
        return followUp(3);
      })
      .catch(function (e) { toast(ACTION_TEXT[action] + "失败：" + e.message, true); })
      .then(function () {
        BUSY[key] = false;
        setMachineLocked(id, false);
        setBtnBusy(btn, false);
      });
  };

  // 停止丢失内存与进程，暂停会中断当前会话，两者都先确认
  if (action === "stop" || action === "suspend") {
    var isStop = action === "stop";
    confirmDialog({
      title: isStop ? "停止这台机器？" : "暂停这台机器？",
      message: isStop
        ? "停止等于关机：内存和运行中的进程都会丢失，只有 /data 里的文件保留。下次启动是冷启动。"
        : "暂停会保留内存和运行中的进程，唤醒后从原地继续，不会冷启动。空闲 30 分钟也会自动暂停。",
      okText: isStop ? "停止" : "暂停",
      danger: isStop
    }).then(function (ok) { if (ok) run(); });
    return;
  }
  run();
}

function removeMachine(id, name, btn) {
  var key = "del:" + id;
  if (BUSY[key]) return;
  confirmDialog({
    title: "删除「" + name + "」？",
    message: "机器和它 /data 里的所有文件都会被永久删除，无法恢复。",
    okText: "删除",
    danger: true
  }).then(function (ok) {
    if (!ok) return;
    BUSY[key] = true;
    setMachineLocked(id, true);
    setBtnBusy(btn, true);
    api("/machines/" + id, { method: "DELETE" })
      .then(function () {
        toast("已下发删除指令 · " + name);
        return followUp(3);
      })
      .catch(function (e) { toast("删除失败：" + e.message, true); })
      .then(function () {
        BUSY[key] = false;
        setMachineLocked(id, false);
        setBtnBusy(btn, false);
      });
  });
}

/** 保活开关：先本地切状态（即时反馈），失败再回滚 */
function toggleKa(id, enable, el) {
  var key = "ka:" + id;
  if (BUSY[key] || MACHINE_BUSY[id]) return;
  BUSY[key] = true;
  setMachineLocked(id, true);

  if (el) { el.classList.toggle("on", enable); el.disabled = true; }

  var target = findMachine(id);
  var label = target ? target.name : id;

  api("/machines/" + id + "/keepalive", {
    method: "POST",
    body: JSON.stringify({ enable: enable, name: label })
  })
    .then(function (r) {
      if (r.warning) toast(r.warning, true);
      else toast((enable ? "自动保活已开启 · " : "自动保活已关闭 · ") + label);
      return loadAll();
    })
    .catch(function (e) {
      if (el) el.classList.toggle("on", !enable);
      toast((enable ? "开启保活失败：" : "关闭保活失败：") + e.message, true);
    })
    .then(function () {
      BUSY[key] = false;
      setMachineLocked(id, false);
      if (el) el.disabled = false;
    });
}

// ---------- 事件绑定 ----------
document.addEventListener("click", function (e) {
  var tab = e.target.closest("[data-tab]");
  if (tab) { switchTab(tab.getAttribute("data-tab")); return; }

  var del = e.target.closest("[data-del]");
  if (del) { removeMachine(del.getAttribute("data-del"), del.getAttribute("data-name"), del); return; }

  var act = e.target.closest("[data-act]");
  if (act) { lifecycle(act.getAttribute("data-id"), act.getAttribute("data-act"), act); return; }

  var sw = e.target.closest("[data-toggle]");
  if (sw) { toggleKa(sw.getAttribute("data-toggle"), !sw.classList.contains("on"), sw); }
});

document.getElementById("loginBtn").addEventListener("click", login);
document.getElementById("pwd").addEventListener("keydown", function (e) {
  if (e.key === "Enter") login();
});
document.getElementById("refreshBtn").addEventListener("click", function (e) {
  var btn = e.currentTarget;
  if (btn.disabled) return;
  setBtnBusy(btn, true);
  loadAll().then(function (problems) {
    setBtnBusy(btn, false);
    if (problems && problems.length) toast("刷新完成，部分数据失败：" + problems.join("；"), true);
    else toast("已刷新 · " + DATA.machines.length + " 台机器");
  });
});

document.getElementById("logoutBtn").addEventListener("click", function () {
  logout();
  toast("已退出登录");
});

document.getElementById("clearLogsBtn").addEventListener("click", function (e) {
  var btn = e.currentTarget;
  if (btn.disabled) return;
  confirmDialog({
    title: "清空保活日志？",
    message: "只清除日志记录，机器和保活配置不受影响。",
    okText: "清空",
    danger: true
  }).then(function (ok) {
    if (!ok) return;
    setBtnBusy(btn, true);
    api("/logs", { method: "DELETE" })
      .then(function () { toast("日志已清空"); return loadAll(); })
      .catch(function (err) { toast(err.message, true); })
      .then(function () { setBtnBusy(btn, false); });
  });
});

// ---------- 启动 ----------
if (AUTH) {
  api("/auth", { method: "POST" })
    .then(showMain)
    .catch(function () { logout(); });
} else {
  showLogin();
}
</script>
</body>
</html>`;
}
