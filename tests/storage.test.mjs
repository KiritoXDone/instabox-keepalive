import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import worker from "../worker.js";
import { loadConfigs, saveConfig, dropConfig, addLog, loadLogs } from "../storage.js";

let mf;
let env;
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    workers: [{
      name: "test",
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } };',
      compatibilityDate: "2026-10-01",
      d1Databases: ["DB"],
    }],
  }));
  env = { DB: await mf.getD1Database("DB"), ADMIN_PASSWORD: "test-password", INSTABOX_API_KEY: "ibk_test" };
  const sql = await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
  await env.DB.batch(sql.split(";").map((s) => s.trim()).filter(Boolean).map((s) => env.DB.prepare(s)));
});
after(async () => { await mf?.dispose(); });
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DROP TRIGGER IF EXISTS reject_log_trim"),
    env.DB.prepare("DELETE FROM machine_configs"),
    env.DB.prepare("DELETE FROM keepalive_logs"),
  ]);
});

function request(path, method = "GET", body) {
  return new Request("https://panel.test/api" + path, {
    method,
    headers: { "X-Panel-Auth": env.ADMIN_PASSWORD, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("missing D1 is explicit and API authentication still fails closed", async () => {
  await assert.rejects(loadConfigs({}), /未配置 D1/);
  const response = await worker.fetch(new Request("https://panel.test/api/logs"), env);
  assert.equal(response.status, 401);
});

test("config round trip, replacement and deletion preserve other machines", async () => {
  assert.deepEqual(await loadConfigs(env), {});
  const id = "m_quote'; DROP TABLE machine_configs;--";
  const config = { keepalive: "on", name: "测试机", lastStatus: "ok", leaseExpiresAt: "2026-10-26T07:00:00Z" };
  await saveConfig(env, id, config);
  await saveConfig(env, "m_other", { keepalive: "off" });
  assert.deepEqual((await loadConfigs(env))[id], config);
  await saveConfig(env, id, { keepalive: "off" });
  assert.deepEqual((await loadConfigs(env))[id], { keepalive: "off" });
  await dropConfig(env, id);
  assert.deepEqual(await loadConfigs(env), { m_other: { keepalive: "off" } });
});

test("logs retain 200, return the newest 50 and clear without deleting config", async () => {
  await saveConfig(env, "m_keep", { keepalive: "on" });
  await env.DB.batch(Array.from({ length: 205 }, (_, index) =>
    env.DB.prepare("INSERT INTO keepalive_logs (entry_json) VALUES (?)").bind(JSON.stringify({ index }))
  ));
  await addLog(env, { index: 205 });
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM keepalive_logs").first()).n, 200);
  assert.deepEqual((await loadLogs(env)).map((entry) => entry.index), Array.from({ length: 50 }, (_, i) => 205 - i));
  const response = await worker.fetch(request("/logs"), env);
  assert.deepEqual((await response.json()).logs, await loadLogs(env));
  assert.equal((await worker.fetch(request("/logs", "DELETE"), env)).status, 200);
  assert.deepEqual(await loadLogs(env), []);
  assert.deepEqual(await loadConfigs(env), { m_keep: { keepalive: "on" } });
});

test("log append rolls back if retention fails", async () => {
  await env.DB.batch(Array.from({ length: 200 }, (_, index) =>
    env.DB.prepare("INSERT INTO keepalive_logs (entry_json) VALUES (?)").bind(JSON.stringify({ index }))
  ));
  await env.DB.prepare("CREATE TRIGGER reject_log_trim BEFORE DELETE ON keepalive_logs BEGIN SELECT RAISE(ABORT, 'test trim failure'); END").run();
  await assert.rejects(addLog(env, { index: 200 }), /test trim failure/);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM keepalive_logs").first()).n, 200);
  assert.equal((await loadLogs(env))[0].index, 199);
});

test("missing schema returns an API error instead of a false empty log list", async () => {
  await env.DB.prepare("ALTER TABLE keepalive_logs RENAME TO hidden_logs").run();
  try {
    const response = await worker.fetch(request("/logs"), env);
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /keepalive_logs/);
  } finally {
    await env.DB.prepare("ALTER TABLE hidden_logs RENAME TO keepalive_logs").run();
  }
});

test("keepalive API and scheduled handler persist leases using D1", async (t) => {
  const calls = [];
  const expiry = "2026-10-26T07:00:00Z";
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), ...options });
    assert.equal(String(url), "https://api.instabox.sh/v1/machines/m_target/activity-leases/keepalive");
    assert.equal(options.method, "PUT");
    assert.deepEqual(JSON.parse(options.body), { ttlSeconds: 3600 });
    return Response.json({ machineId: "m_target", expiresAt: expiry });
  });
  const response = await worker.fetch(request("/machines/m_target/keepalive", "POST", { enable: true, name: "target" }), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).warning, null);
  await saveConfig(env, "m_disabled", { keepalive: "off" });
  await worker.scheduled({}, env, {});
  assert.equal(calls.length, 2);
  assert.equal((await loadConfigs(env)).m_target.leaseExpiresAt, expiry);
  assert.equal((await loadLogs(env))[0].action, "自动保活");
  await worker.fetch(request("/machines/m_target/keepalive", "POST", { enable: false }), env);
  await worker.scheduled({}, env, {});
  assert.equal(calls.length, 2);
});

test("provider failure is recorded without claiming a successful lease", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { code: "expired_key" } }, { status: 401 }));
  const response = await worker.fetch(request("/machines/m_target/keepalive", "POST", { enable: true }), env);
  const body = await response.json();
  assert.match(body.warning, /401 expired_key/);
  const config = (await loadConfigs(env)).m_target;
  assert.equal(config.lastStatus, "failed");
  assert.equal(config.leaseExpiresAt, null);
  assert.equal((await loadLogs(env))[0].ok, false);
});
