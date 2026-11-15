/**
 * Graphical console tile for Proxmox VMs: noVNC over /ws/proxmox/vnc
 *
 * The platform authenticates to Proxmox's VNC server itself and hands this
 * tile an already-authenticated RFB stream, so no password or ticket ever
 * reaches the browser; We open the WebSocket ourselves (noVNC accepts an
 * existing channel) to read the server's close reason for error messages
 */
import RFB from '/vendor/novnc/core/rfb.js';
import { h, icon } from '../core/dom.js';
import { t, tAttr } from '../core/i18n.js';
import { BasePane } from './pane.js';

export class VncPane extends BasePane {
  constructor(session, opts) {
    const cad = h('button.icon-btn', { type: 'button', ...tAttr('title', 'terminal.actions.ctrlAltDel'), onclick: () => this.rfb?.sendCtrlAltDel() }, icon('keyboard'));
    super(session, opts, [cad]);
    this.screen = h('div.vnc-screen');
    this.body.append(this.screen);
  }

  attach() { this.connect(); }

  connect() {
    this.#teardown();
    this.setState('connecting', () => t('terminal.vnc.opening'));
    this.hideEnd();

    const ws = new WebSocket(this.wsUrl());
    ws.binaryType = 'arraybuffer';
    let closeInfo = null;
    ws.addEventListener('close', (e) => { closeInfo = e; });

    const rfb = (this.rfb = new RFB(this.screen, ws, { shared: true }));
    rfb.scaleViewport = true;     // fit the VM screen into the tile
    rfb.resizeSession = false;    // never resize the guest's display
    rfb.background = '#0F1821';
    rfb.focusOnClick = true;
    rfb.addEventListener('connect', () => this.setState('connected', () => t('terminal.phase.connected')));
    rfb.addEventListener('disconnect', (e) => {
      if (this.rfb !== rfb) return;
      // Our server closes with code 4000 and a readable reason when Proxmox refuses
      const reason = closeInfo?.code === 4000 ? closeInfo.reason : null;
      if (reason) this.showEnd('error', reason);
      else this.showEnd('closed', () => t(e.detail.clean ? 'terminal.vnc.closed' : 'terminal.vnc.lost'));
    });
    rfb.addEventListener('credentialsrequired', () => {
      rfb.disconnect();
      this.showEnd('error', () => t('terminal.vnc.credentials'));
    });
  }

  fit() { /* noVNC rescales itself when the tile resizes */ }

  focus() { this.rfb?.focus(); }

  #teardown() {
    if (!this.rfb) return;
    const old = this.rfb;
    this.rfb = null;
    try { old.disconnect(); } catch { /* already closed */ }
  }

  dispose() {
    this.release();
    this.#teardown();
    this.el.remove();
  }
}
