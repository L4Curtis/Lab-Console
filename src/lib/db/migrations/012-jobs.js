/**
 * Bench jobs and the configurations they keep (src/modules/jobs/, SPEC "Lot
 * jobs"). The configuration files stay files (data/snapshots/<bench>/<id>/,
 * data/templates/<id>/: one .cfg per device, VLAN listings, a manifest):
 * the database is their index, with a SHA-256 per file so that a backup is
 * checked against what was written before anything is erased.
 *
 *   jobs               one row per job: kind, bench, who started it, the team
 *                      that held the bench, the options (never a password),
 *                      the per-device report once it ends
 *   snapshots          a set of configurations of one bench, owned by the
 *                      team that held the bench (team_id null: admins only)
 *   snapshot_devices   one device of a snapshot: its files, hashes and facts;
 *                      startup_file: the startup-config, kept when it was not
 *                      the running-config (a reset erases it)
 *   templates          TP templates published by admins; `base` marks the
 *                      base configuration applied after a reset
 *   template_devices   one device (or '*': every device) of a template
 */
export async function up(tx) {
  await tx.run(`CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    bench TEXT NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    team_id TEXT,
    actor TEXT NOT NULL,
    options TEXT NOT NULL,
    devices TEXT NOT NULL,
    snapshot_id TEXT,
    created_at TEXT NOT NULL,
    ended_at TEXT
  )`);
  await tx.run('CREATE INDEX jobs_bench ON jobs (bench, created_at)');

  await tx.run(`CREATE TABLE snapshots (
    id TEXT PRIMARY KEY,
    bench TEXT NOT NULL,
    team_id TEXT,
    label TEXT NOT NULL,
    origin TEXT NOT NULL,
    job_id TEXT,
    author TEXT NOT NULL,
    dir TEXT NOT NULL,
    created_at TEXT NOT NULL,
    bytes BIGINT NOT NULL
  )`);
  await tx.run('CREATE INDEX snapshots_bench ON snapshots (bench, created_at)');
  await tx.run('CREATE INDEX snapshots_team ON snapshots (team_id)');

  await tx.run(`CREATE TABLE snapshot_devices (
    snapshot_id TEXT NOT NULL,
    device TEXT NOT NULL,
    file TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bytes BIGINT NOT NULL,
    vlan_file TEXT,
    vlan_sha256 TEXT,
    startup_file TEXT,
    startup_sha256 TEXT,
    facts TEXT NOT NULL,
    PRIMARY KEY (snapshot_id, device)
  )`);

  await tx.run(`CREATE TABLE templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    base INTEGER NOT NULL,
    dir TEXT NOT NULL,
    author TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await tx.run('CREATE UNIQUE INDEX templates_name ON templates (name)');

  await tx.run(`CREATE TABLE template_devices (
    template_id TEXT NOT NULL,
    device TEXT NOT NULL,
    file TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bytes BIGINT NOT NULL,
    vlan_file TEXT,
    vlan_sha256 TEXT,
    startup_file TEXT,
    startup_sha256 TEXT,
    facts TEXT NOT NULL,
    PRIMARY KEY (template_id, device)
  )`);
}
