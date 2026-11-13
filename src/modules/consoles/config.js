/**
 * Settings of the shared consoles (config.rooms): how long journals are
 * kept and how big they may grow, and how many console lines share one SSH
 * connection to the jump server. The timings of a room (30 s to answer a
 * control request, 2 min idle pilot, 30 s of grace after the last person
 * leaves) are product decisions (SPEC "Lot rooms"), not settings
 */
import { int } from '../../lib/env.js';

export function readConfig() {
  return {
    journal: {
      // Days of console output kept (today included); older days are deleted by a daily sweep
      retentionDays: int('JOURNAL_RETENTION_DAYS', 14, { min: 1, max: 366 }),
      // Size cap of one device's journal for one day, in KB; past it the journal stops for the day
      maxBytesPerDay: int('JOURNAL_MAX_KB_PER_DAY', 5120, { min: 64, max: 512 * 1024 }) * 1024,
      // Size cap of every journal together, in MB; past it, the oldest days are deleted first
      maxTotalBytes: int('JOURNAL_MAX_TOTAL_MB', 1024, { min: 1, max: 1024 * 1024 }) * 1024 * 1024,
    },
    // Exec channels one SSH connection to the jump server may carry. Keep it
    // below the jump server's sshd MaxSessions (10 by default): line probes use channels too
    channelsPerConnection: int('SSH_CHANNELS_PER_CONNECTION', 8, { min: 1, max: 64 }),
  };
}
