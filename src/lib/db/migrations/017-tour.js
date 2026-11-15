/**
 * Guided tour (src/modules/help/): what each person did with it.
 *
 * tour_progress: at most one row per user (the id of the sign-in: an SSO
 * account, a local account or the environment's administrator). `state` is
 * 'done' (they went to the end) or 'skipped'; no row means the tour was never
 * shown, which is what starts it at the first sign-in. Replaying the tour from
 * the user menu writes nothing
 */
export async function up(tx) {
  await tx.run(`CREATE TABLE tour_progress (
    user_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
}
