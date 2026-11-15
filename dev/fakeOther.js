/**
 * A console device that is NOT Cisco IOS, for the mock lab and the tests: an
 * HPE Aruba 2530 switch (ArubaOS-Switch). The jobs must recognise it and
 * leave it untouched: its prompts look like Cisco ones ("Aruba-2530-24G>",
 * "#" after `enable`), but `show version` says something else entirely.
 *
 * Only what the driver touches is imitated: echo, `enable`, `exit`,
 * `terminal length`, `show version`, `show running-config`; anything else is
 * "Invalid input: <word>". It counts what it was asked, so a test can check
 * that nothing destructive was ever typed (`commandLog`).
 */
export class FakeOther {
  constructor({ hostname = 'Aruba-2530-24G', out = () => {} } = {}) {
    this.hostname = hostname;
    this.out = out;
    this.mode = '>';
    this.line = '';
    this.commandLog = [];
    this.model = 'aruba';
  }

  get kind() { return 'switch'; }
  get family() { return 'arubaos-switch'; }

  stop() {}
  sendBreak() {}

  input(data) {
    for (const ch of String(data)) {
      if (ch === '\r') { this.#enter(); continue; }
      if (ch === '\n') continue;
      if (ch === '\x7f' || ch === '\b') { if (this.line) { this.line = this.line.slice(0, -1); this.out('\b \b'); } continue; }
      if (ch < ' ') continue;
      this.line += ch;
      this.out(ch);
    }
  }

  #prompt() { this.out(`\r\n${this.hostname}${this.mode} `); }

  #enter() {
    const cmd = this.line.trim();
    this.line = '';
    if (cmd) this.commandLog.push(cmd);
    const [word, ...rest] = cmd.split(/\s+/);
    const say = (text) => this.out(`\r\n${text.replace(/\n/g, '\r\n')}`);
    if (!cmd) return this.#prompt();
    if (word === 'enable' || word === 'en') { this.mode = '#'; return this.#prompt(); }
    if (word === 'exit') { this.mode = '>'; return this.#prompt(); }
    if (word === 'terminal' && rest[0] === 'length') {
      if (!/^\d+$/.test(rest[1] ?? '') || Number(rest[1]) < 1) say(`Invalid input: ${rest[1] ?? ''}`);
      return this.#prompt();
    }
    if (/^sh(ow)?$/.test(word) && /^ver/.test(rest[0] ?? '')) {
      say(['', 'Image stamp:    /ws/swbuildm/rel_yorktown_qaoff/code/build/lp(swbuildm_rel_yorktown_qaoff_rel_yorktown)',
        '                Nov 13 2020 13:03:26', '                YB.16.10.0012', '                1035', 'Boot Image:     Primary', ''].join('\n'));
      return this.#prompt();
    }
    if (/^sh(ow)?$/.test(word) && /^run/.test(rest[0] ?? '') && this.mode === '#') {
      say(['', 'Running configuration:', '', '; J9776A Configuration Editor; Created on release #YB.16.10.0012', '; Ver #14:01.4f.f8.1d.9b.3f.bf.bb.ef.7c.59.fc.6b.fb.9f.fc.ff.ff.37.ef:01',
        `hostname "${this.hostname}"`, 'vlan 1', '   name "DEFAULT_VLAN"', '   untagged 1-28', '   ip address dhcp-bootp', '   exit', ''].join('\n'));
      return this.#prompt();
    }
    say(`Invalid input: ${word}`);
    return this.#prompt();
  }
}
