/**
 * "Clone template" dialog: template, name, node, VLAN tag of net0
 */
import { h, icon, toast } from '../../core/dom.js';
import { request } from '../../core/api.js';
import { t, tAttr, tNode } from '../../core/i18n.js';

export function openCloneDialog({ templates, nodes }) {
  const tpl = h('select.field', { required: true }, templates.map((tm) => h('option', { value: tm.vmid }, `${tm.name} (${tm.vmid}, ${tm.node})`)));
  const name = h('input.field', { required: true, pattern: '[A-Za-z0-9]([A-Za-z0-9\\-]{0,61}[A-Za-z0-9])?', ...tAttr('placeholder', 'infra.clone.namePlaceholder'), autocomplete: 'off' });
  const node = h('select.field', h('option', { value: '' }, tNode('infra.clone.sameNode')), nodes.map((n) => h('option', { value: n }, n)));
  const vlan = h('input.field', { type: 'number', min: 1, max: 4094, ...tAttr('placeholder', 'infra.clone.untagged') });
  const error = h('p.form-error', { role: 'alert' });
  const submit = h('button.btn.primary', { type: 'submit' }, tNode('infra.clone.submit'));

  const form = h('form.modal-body.form-grid', {
    onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      try {
        await request('POST', '/api/proxmox/clone', {
          template: Number(tpl.value), name: name.value.trim(), node: node.value || undefined,
          vlan: vlan.value === '' ? null : Number(vlan.value),
        });
        toast(t('infra.clone.started', { name: name.value.trim() }));
        dlg.close();
      } catch (err) {
        error.textContent = err.message;
        submit.disabled = false;
      }
    },
  },
  h('label', tNode('infra.clone.template'), tpl),
  h('label', tNode('infra.clone.name'), name, h('small', tNode('infra.clone.nameHint'))),
  h('label', tNode('infra.clone.node'), node),
  h('label', tNode('infra.clone.vlan'), vlan, h('small', tNode('infra.clone.vlanHint'))),
  error,
  h('div.form-actions', h('button.btn', { type: 'button', onclick: () => dlg.close() }, tNode('common.actions.cancel')), submit));

  const dlg = h('dialog.modal', tAttr('aria-label', 'infra.clone.title'),
    h('header.modal-head', h('h2', tNode('infra.clone.title')),
      h('button.icon-btn', { type: 'button', ...tAttr('title', 'common.actions.close'), onclick: () => dlg.close() }, icon('close'))),
    form);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  requestAnimationFrame(() => name.focus());
}
