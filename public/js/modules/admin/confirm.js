/**
 * Ask the administrator to confirm a sensitive change before it is sent
 * (the lab parameters). → { ticket } to send with the change, { redirected }
 * when the browser is on its way to the identity provider, or null when cancelled
 *
 *   - the environment's administrator types its password and a fresh code;
 *   - an administrator account with a passkey uses it (the browser's dialog);
 *   - an SSO administrator signs in again at the provider: the values are
 *     handed to the server, which applies them when the person comes back
 *     (the lab page then reads the outcome).
 * The server checks everything; a ticket is good for one change, 2 minutes
 */
import { startAuthentication } from '/vendor/simplewebauthn/index.js';
import { request, getJson } from '../../core/api.js';
import { t } from '../../core/i18n.js';
import { formDialog, confirmDialog } from '../../shared/dialog.js';
import { isCancelled } from '../../core/passkeys.js';

export async function askConfirmation(values) {
  const { method } = await getJson('/api/admin/confirm');
  if (method === 'totp') {
    const result = await formDialog({
      title: t('admin.confirm.title'),
      intro: t('admin.confirm.totpIntro'),
      fields: [
        { name: 'password', label: t('admin.confirm.password'), type: 'password', required: true, attrs: { autocomplete: 'current-password' } },
        { name: 'code', label: t('admin.confirm.code'), type: 'text', required: true, attrs: { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', pattern: '[0-9]{6}' } },
      ],
      submitLabel: t('admin.confirm.submit'),
      onSubmit: (values) => request('POST', '/api/admin/confirm', { password: values.password, code: values.code.trim() }),
    });
    return result?.ticket ? { ticket: result.ticket } : null;
  }
  if (method === 'passkey') {
    const go = await confirmDialog({ title: t('admin.confirm.title'), body: t('admin.confirm.passkeyIntro'), confirmLabel: t('admin.confirm.passkey') });
    if (!go) return null;
    try {
      const options = await request('POST', '/api/admin/confirm/options', {});
      const response = await startAuthentication({ optionsJSON: options });
      return { ticket: (await request('POST', '/api/admin/confirm', { response })).ticket };
    } catch (err) {
      if (isCancelled(err)) return null;
      throw err;
    }
  }
  if (method === 'sso') {
    const go = await confirmDialog({ title: t('admin.confirm.title'), body: t('admin.confirm.ssoIntro'), confirmLabel: t('admin.confirm.sso') });
    if (!go) return null;
    const { url } = await request('POST', '/api/admin/lab/confirm-sso', { values });
    location.assign(url);
    return { redirected: true };
  }
  await confirmDialog({ title: t('admin.confirm.title'), body: t('admin.confirm.unavailable'), confirmLabel: t('common.actions.ok') });
  return null;
}
