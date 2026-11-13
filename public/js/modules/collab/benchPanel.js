/**
 * The group panel of the consoles section: the notes of the bench on screen
 * and its chat (SPEC "Lot collab")
 *
 *   const panel = mountBenchPanel({ host });   // the panel goes in `host`
 *   panel.setBench(lab);                       // the lab on screen
 *   panel.button / panel.el / panel.toggle(on) / panel.open   // the same contract as the live panel;
 *                                              // whoever mounts it puts the button where it belongs
 *                                              // (the consoles section: under the title of the diagram)
 *
 * Notes: every device of the bench that has one, with its text; the people
 * who may write it get a button. Chat: the bench's occupants talk (admins
 * read); it belongs to the team that holds the bench, so it is empty for a
 * bench nobody holds and for a person who does not work on it. Messages
 * arrive over the SSE topic 'collab:chat', which the server sends to the
 * bench's occupants and the admins only. The button counts the messages that
 * came while the panel was shut. A message is shown as text, whatever it says
 */
import { h, icon } from '../../core/dom.js';
import { getJson, request, live } from '../../core/api.js';
import { t, tNode, tAttr, onLocaleChange, getLocale } from '../../core/i18n.js';
import { session } from '../../core/session.js';
import { avatar } from '../../shared/presenceBar.js';
import { benchSummary, isOccupant, onBenches } from '../teams/data.js';
import { noteOf, onNotes, mayEdit, openNoteDialog, knowDevices } from './notes.js';

const clock = (iso) => new Intl.DateTimeFormat(getLocale(), { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

export function mountBenchPanel({ host }) {
  let lab = null;
  let messages = [];     // the thread of the bench on screen, oldest first
  let chatFor = null;    // the bench `messages` belong to
  let canPost = false;
  let maxChars = 500;
  let unread = 0;

  // ── Elements ──────────────────────────────────────────────────────────────
  const badge = h('span.live-badge', { hidden: true });
  const button = h('button.btn.small.collab-btn', { type: 'button', 'aria-pressed': 'false', onclick: () => toggle() }, icon('chat'), tNode('collab.panel.button'), badge);

  const notesList = h('ul.collab-notes');
  const chatLog = h('ol.chat-log', { 'aria-live': 'polite', ...tAttr('aria-label', 'collab.chat.log') });
  const chatHint = h('p.chat-hint.muted');
  const field = h('textarea.chat-input', { rows: 2, maxlength: '500', ...tAttr('placeholder', 'collab.chat.placeholder'), ...tAttr('aria-label', 'collab.chat.field') });
  const problem = h('p.chat-problem', { role: 'alert', hidden: true });
  const send = h('button.btn.small.primary', { type: 'submit', dataset: { action: 'send' } }, icon('send'), tNode('collab.chat.send'));
  const form = h('form.chat-form', { onsubmit: submit }, field, h('div.chat-form-foot', problem, send));
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  const chatSection = h('section.live-section.chat-section', h('h3', tNode('collab.chat.title')), chatHint, chatLog, form);
  const title = h('h2');
  const el = h('aside.live-panel.collab-panel', { hidden: true, ...tAttr('aria-label', 'collab.panel.title') },
    h('header.live-head', title, h('span.live-count'),
      h('button.icon-btn', { type: 'button', ...tAttr('title', 'common.actions.close'), onclick: () => toggle(false) }, icon('close'))),
    h('section.live-section', h('h3', tNode('collab.panel.notesHeading')), notesList),
    chatSection);
  host.append(el);

  // ── State ─────────────────────────────────────────────────────────────────
  const bench = () => lab?.name ?? null;
  const summary = () => benchSummary(bench());
  /** May this person read the chat of the bench on screen? The server decides again */
  const mayRead = () => Boolean(bench()) && (session.isAdmin || isOccupant(summary()));
  const isOpen = () => !el.hidden;

  function toggle(on = el.hidden) {
    el.hidden = !on;
    el.dispatchEvent(new Event('toggle'));
    button.setAttribute('aria-pressed', String(on));
    if (on) {
      unread = 0;
      showBadge();
      loadChat();
      if (!form.hidden) field.focus();
    }
  }

  function showBadge() {
    badge.hidden = unread === 0;
    badge.textContent = String(unread);
    badge.title = t('collab.chat.unread', { count: unread });
  }

  // ── Notes ─────────────────────────────────────────────────────────────────
  function renderNotes() {
    title.textContent = t('collab.panel.titleFor', { bench: bench() ?? '' });
    const rows = (lab?.devices ?? [])
      .map((d) => ({ d, note: noteOf(d.key), edit: mayEdit(lab.name) }))
      .filter(({ note, edit }) => note || edit);
    if (!rows.length) {
      notesList.replaceChildren(h('li.live-empty', tNode('collab.notes.nothing')));
      return;
    }
    notesList.replaceChildren(...rows.map(({ d, note, edit }) => h('li.collab-note', { dataset: { device: d.name } },
      h('div.collab-note-head', h('strong', d.name),
        h('button.btn.small.subtle', { type: 'button', dataset: { action: 'note' }, onclick: () => openNoteDialog(d.key) },
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
    field.maxLength = maxChars;
    chatLog.replaceChildren(...(readable ? messages : []).map((m) => h('li.chat-message', { dataset: { id: m.id, mine: String(m.author.id === session.user?.id) } },
      avatar(m.author),
      h('div.chat-body',
        h('div.chat-meta', h('strong', m.author.name), h('time', { datetime: m.at }, clock(m.at)),
          session.isAdmin ? h('button.icon-btn.small', { type: 'button', ...tAttr('title', 'collab.chat.remove'), dataset: { action: 'remove' }, onclick: () => remove(m) }, icon('trash')) : null),
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
      if (data.bench === chatFor) { messages = messages.filter((m) => m.id !== data.removed); renderChat(); }
      return;
    }
    const mine = data.message.author.id === session.user?.id;
    if (data.bench === bench() && isOpen()) { add(data.message); return; }
    if (!mine) { unread += 1; showBadge(); }
  });

  onNotes(renderNotes);
  onBenches(() => { renderNotes(); renderChat(); if (isOpen() && chatFor !== bench()) loadChat(); });
  onLocaleChange(() => { renderNotes(); renderChat(); showBadge(); });

  return {
    el,
    button,
    get open() { return isOpen(); },
    toggle,
    setBench(next) {
      lab = next;
      if (next) knowDevices([next]);
      messages = [];
      chatFor = null;
      renderNotes();
      renderChat();
      if (isOpen()) { unread = 0; showBadge(); loadChat(); }
    },
  };
}
