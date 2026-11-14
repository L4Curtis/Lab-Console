/**
 * Password recoveries (src/modules/recovery/, SPEC "Lot recovery"): one row
 * per recovery started on a device, written when it starts, after each step
 * and when it ends, so that the history of a device says who recovered it,
 * how (family), which steps ran and how it ended. No password is involved
 * anywhere: the assistant bypasses the startup-config, it never reads one.
 *
 *   recoveries   bench, device (key and name), family, who started it, the
 *                team that held the bench, state ('awaiting', 'running',
 *                'done', 'failed', 'cancelled'), the steps with their
 *                outcome (JSON), the code it ended with, and the bypass
 *                the device was left with ('register' | 'parked' |
 *                'ignore', or NULL: nothing left), which the next recovery
 *                of the device puts back, and how the last put-back
 *                ended (JSON { ok, booted, at, code }: a device put back
 *                without booting, at shutdown, sits in ROMMON / at switch:)
 */
export async function up(tx) {
  await tx.run(`CREATE TABLE recoveries (
    id TEXT PRIMARY KEY,
    bench TEXT NOT NULL,
    device_key TEXT NOT NULL,
    device_name TEXT NOT NULL,
    family TEXT NOT NULL,
    actor TEXT NOT NULL,
    team_id TEXT,
    state TEXT NOT NULL,
    steps TEXT NOT NULL,
    code TEXT,
    bypassed TEXT,
    put_back TEXT,
    created_at TEXT NOT NULL,
    ended_at TEXT
  )`);
  await tx.run('CREATE INDEX recoveries_bench ON recoveries (bench, created_at)');
  await tx.run('CREATE INDEX recoveries_device ON recoveries (device_key, created_at)');
}
