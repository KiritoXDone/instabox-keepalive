/** D1 persistence; keep the upstream config objects and log entries unchanged. */
const LOG_KEEP = 200;

function database(env) {
  if (!env.DB) throw new Error("未配置 D1 数据库绑定 DB");
  return env.DB;
}

export async function loadConfigs(env) {
  const { results } = await database(env)
    .prepare("SELECT machine_id, config_json FROM machine_configs")
    .all();
  const configs = {};
  for (const row of results) {
    configs[row.machine_id] = JSON.parse(row.config_json);
  }
  return configs;
}

export async function saveConfig(env, machineId, config) {
  await database(env).prepare(
    "INSERT INTO machine_configs (machine_id, config_json) VALUES (?, ?) " +
    "ON CONFLICT(machine_id) DO UPDATE SET config_json = excluded.config_json"
  ).bind(machineId, JSON.stringify(config)).run();
}

export async function dropConfig(env, machineId) {
  await database(env).prepare("DELETE FROM machine_configs WHERE machine_id = ?")
    .bind(machineId).run();
}

export async function addLog(env, entry) {
  const db = database(env);
  // Batch is transactional, so append and retention trimming succeed together.
  await db.batch([
    db.prepare("INSERT INTO keepalive_logs (entry_json) VALUES (?)")
      .bind(JSON.stringify(entry)),
    db.prepare(
      "DELETE FROM keepalive_logs WHERE id NOT IN " +
      "(SELECT id FROM keepalive_logs ORDER BY id DESC LIMIT ?)"
    ).bind(LOG_KEEP),
  ]);
}

export async function loadLogs(env) {
  const { results } = await database(env)
    .prepare("SELECT entry_json FROM keepalive_logs ORDER BY id DESC LIMIT 50")
    .all();
  return results.map((row) => JSON.parse(row.entry_json));
}

export async function clearLogs(env) {
  await database(env).prepare("DELETE FROM keepalive_logs").run();
}
