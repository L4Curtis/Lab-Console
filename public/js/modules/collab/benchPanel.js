/**
 * The group panel of the consoles section: the notes of the bench on screen
 * and its chat (SPEC "Lot collab")
 *
 *   const panel = mountBenchPanel({ host });   // `host`: the section's side host (shared/sidePanel.js)
 *   panel.setBench(lab);                       // the lab on screen
 *   panel.button / panel.el / panel.toggle(on) / panel.open / panel.onToggle(fn) / panel.unread
 *                                              // the same contract as the live panel; whoever mounts it
 *                                              // puts the button where it belongs (the consoles header)
 *
 * It is a side panel: a column beside the consoles from 1200 px, a drawer
 * below, a full-height sheet on a phone; the chat's composer is its footer
 *
 * Notes: every device of the bench that has one, with its text; the people
 * who may write it get a button. Chat: the bench's occupants talk (admins
 * read); it belongs to the team that holds the bench, so it is empty for a
 * bench nobody holds and for a person who does not work on it. Messages
 * arrive over the SSE topic 'collab:chat', which the server sends to the
 * bench's occupants and the admins only. The button counts, for the bench on
 * screen, the messages that came while the panel was shut. A message is shown
 * as text, whatever it says
 */
import { h, icon } from '../../core/dom.js';
import { getJson, request, live } from '../../core/api.js';
import { t, tNode, tAttr, onLocaleChange } from '../../core/i18n.js';
import { sidePanel } from '../../shared/sidePanel.js';
import { fmtTime } from '../../core/format.js';
import { session } from '../../core/session.js';
import { avatar } from '../../shared/presenceBar.js';
import { benchSummary, isOccupant, onBenches } from '../teams/data.js';
import { noteOf, onNotes, mayEdit, openNoteDialog, knowDevices } from './notes.js';

const clock = fmtTime;

export function mountBenchPanel({ host }) {
  let lab = null;
  let messages = [];     // the thread of the bench on screen, oldest first
  let chatFor = null;    // the bench `messages` belong to
  let canPost = false;
  let maxChars = 500;
  const unread = new Map(); // bench → ids of the messages that arrived unseen (a removed message leaves the count)

  // ── Elements ──────────────────────────────────────────────────────────────
  const badge = h('span.count', { hidden: true });
  const button = h('button.btn.collab-btn', { type: 'button', 'aria-pressed': 'false', dataset: { action: 'discussion' }, onclick: () => toggle() }, icon('chat'), h('span.btn-label', tNode('collab.panel.button')), badge);
  const listeners = new Set();

  const notesList = h('ul.collab-notes');
  const chatLog = h('ol.chat-log', { 'aria-live': 'polite', ...tAttr('aria-label', 'collab.chat.log') });
  const chatHint = h('p.chat-hint.muted');
  const field = h('textarea.field.chat-input', { rows: 2, maxlength: '500', ...tAttr('placeholder', 'collab.chat.placeholder'), ...tAttr('aria-label', 'collab.chat.field') });
  const problem = h('p.chat-problem', { role: 'alert', hidden: true });
  const send = h('button.btn.sm.primary', { type: 'submit', dataset: { action: 'send' } }, icon('send'), tNode('collab.chat.send'));
  const form = h('form.chat-form', { onsubmit: submit }, field, h('div.chat-form-foot', problem, send));
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  const panel = sidePanel(host, { title: () => t('collab.panel.titleFor', { bench: lab?.name ?? '' }), footer: form });
  panel.el.classList.add('collab-panel');
  const el = panel.el;
  panel.body.append(
    h('section.live-section', h('h3', tNode('collab.panel.notesHeading')), notesList),
    h('section.live-section.chat-section', h('h3', tNode('collab.chat.title')), chatHint, chatLog));
  panel.onToggle((on) => {
    button.setAttribute('aria-pressed', String(on));
    if (on) {
      unread.delete(bench());
      showBadge();
      loadChat();
      if (!form.hidden) field.focus();
    }
    for (const fn of listeners) fn(on);
  });

  // ── State ─────────────────────────────────────────────────────────────────
  const bench = () => lab?.name ?? null;
  const summary = () => benchSummary(bench());
  /** May this person read the chat of the bench on screen? The server decides again */
  const mayRead = () => Boolean(bench()) && (session.isAdmin || isOccupant(summary()));
  const isOpen = () => panel.isOpen;

  function toggle(on = !panel.isOpen) {
    panel.toggle(on);
  }

  function showBadge() {
    const count = unread.get(bench())?.size ?? 0; // only the bench on screen
    badge.hidden = count === 0;
    badge.textContent = String(count);
    badge.title = t('collab.chat.unread', { count });
    for (const fn of listeners) fn(panel.isOpen);
  }

  // ── Notes ─────────────────────────────────────────────────────────────────
  function renderNotes() {
    const rows = (lab?.devices ?? [])
      .map((d) => ({ d, note: noteOf(d.key), edit: mayEdit(lab.name) }))
      .filter(({ note, edit }) => note || edit);
    if (!rows.length) {
      notesList.replaceChildren(h('li.live-empty', tNode('collab.notes.nothing')));
      return;
    }
    notesList.replaceChildren(...rows.map(({ d, note, edit }) => h('li.collab-note', { dataset: { device: d.name } },
      h('div.collab-note-head', h('strong', d.name),
        h('button.btn.sm.ghost', { type: 'button', dataset: { action: 'note' }, onclick: () => openNoteDialog(d.key) },
          note ? t(edit ? 'collab.notes.edit' : 'collab.notes.open') : t('collab.notes.add'))),
      note ? h('p.collab-note-text', note.text) : null,
      note ? h('span.muted.collab-note-by', t('collab.notes.lastBy', { name: note.by.name, time: clock(note.updatedAt) })) : null)));
  }

  // ── Chat ──────────────────────────────────────────────────────────────────
  function renderChat() {
    const readable = mayRead();
    chatHint.hidden = readable && messages.length > 0;
    chatHint.textContent = !bench() ? '' : !readable ? t('collab.chat.notYours') : t('collab.chat.empty');
    form.hidden = !readable || !canPost;
    panel.footer.hidden = form.hidden;
    field.maxLength = maxChars;
    chatLog.replaceChildren(...(readable ? messages : []).map((m) => h('li.chat-message', { dataset: { id: m.id, mine: String(m.author.id === session.user?.id) } },
      avatar(m.author),
      h('div.chat-body',
        h('div.chat-meta', h('strong', m.author.name), h('time', { datetime: m.at }, clock(m.at)),
          session.isAdmin ? h('button.icon-btn', { type: 'button', ...tAttr('title', 'collab.chat.remove'), ...tAttr('aria-label', 'collab.chat.remove'), dataset: { action: 'remove' }, onclick: () => remove(m) }, icon('trash')) : null),
        h('p.chat-text', m.text)))));
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  async function loadChat() {
    const name = bench();
    if (!name || !mayRead() || !isOpen()) {
      if (chatFor !== name) { messages = []; chatFor = name; }
      renderChat();
      return;
    }
    try {
      const data = await getJson(`/api/collab/chat/${encodeURIComponent(name)}`);
      if (name !== bench()) return;
      messages = data.messages;
      canPost = data.canPost;
      maxChars = data.limits?.maxChars ?? maxChars;
      chatFor = name;
    } catch {
      messages = [];
      chatFor = name;
    }
    renderChat();
  }

  async function submit(e) {
    e.preventDefault();
    const text = field.value.trim();
    if (!text || !bench()) return;
    send.disabled = true;
    problem.hidden = true;
    try {
      const { message } = await request('POST', `/api/collab/chat/${encodeURIComponent(bench())}`, { text });
      field.value = '';
      add(message); // the stream carries it too; ids keep it from being shown twice
    } catch (err) {
      problem.textContent = err.message;
      problem.hidden = false;
    } finally {
      send.disabled = false;
      field.focus();
    }
  }

  async function remove(m) {
    try { await request('DELETE', `/api/collab/chat/${encodeURIComponent(bench())}/${encodeURIComponent(m.id)}`); } catch (err) {
      problem.textContent = err.message;
      problem.hidden = false;
    }
  }

  function add(message) {
    if (message.bench !== undefined && message.bench !== chatFor) return;
    if (messages.some((m) => m.id === message.id)) return;
    messages.push(message);
    renderChat();
  }

  live.on('collab:chat', (data) => {
    if (data.removed) {
      if (unread.get(data.bench)?.delete(data.removed)) showBadge();
      if (data.bench === chatFor) { messages = messages.filter((m) => m.id !== data.removed); renderChat(); }
      return;
    }
    const mine = data.message.author.id === session.user?.id;
    if (data.bench === bench() && isOpen()) { add(data.message); return; }
    if (!mine) {
      if (!unread.has(data.bench)) unread.set(data.bench, new Set());
      unread.get(data.bench).add(data.message.id);
      showBadge();
    }
  });

  onNotes(renderNotes);
  onBenches(() => { renderNotes(); renderChat(); if (isOpen() && chatFor !== bench()) loadChat(); });
  onLocaleChange(() => { renderNotes(); renderChat(); showBadge(); });

  return {
    el,
    button,
    get open() { return isOpen(); },
    /** Messages of the bench on screen that came while the panel was shut */
    get unread() { return unread.get(bench())?.size ?? 0; },
    toggle,
    onToggle(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setBench(next) {
      lab = next;
      if (next) knowDevices([next]);
      messages = [];
      chatFor = null;
      renderNotes();
      renderChat();
      panel.el.querySelector('.side-head h2').textContent = t('collab.panel.titleFor', { bench: bench() ?? '' });
      if (isOpen()) { unread.delete(bench()); loadChat(); }
      showBadge();
    },
  };
}
