/**
 * Downloads of the platform's own files (journals, backups, diagrams, ZIPs).
 * They are plain links, `<a href="/api/…" download>`, so that they work with a
 * middle click and are easy to write; this turns a left click into a request
 * of the page, so that a refusal (403, 404, a network that dropped) is a
 * message in the user's language instead of the server's raw JSON on a
 * blank download
 */
import { request } from './api.js';
import { toast } from './dom.js';

export function interceptDownloads() {
  document.addEventListener('click', async (event) => {
    const link = event.target.closest?.('a[download][href^="/api/"]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    try {
      const { blob, filename } = await request('GET', link.getAttribute('href'), undefined, { as: 'file' });
      const url = URL.createObjectURL(blob);
      const saver = document.createElement('a');
      saver.href = url;
      saver.download = link.getAttribute('download') || filename;
      saver.hidden = true;
      document.body.append(saver);
      saver.click();
      saver.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      toast(err.message, 'error', 7000);
    }
  });
}
