CREATE TABLE machine_configs (
  machine_id TEXT PRIMARY KEY NOT NULL,
  config_json TEXT NOT NULL CHECK (json_valid(config_json))
);

CREATE TABLE keepalive_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_json TEXT NOT NULL CHECK (json_valid(entry_json))
);
