/**
 * Owns the parsed diagram: loads it at startup, reloads it when the file
 * changes on disk (instructors can edit diagrams live) and answers the only
 * question the session layer asks: "which console does device <key> map to?"
 */
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { parseDrawio } from './drawio.js';

export class LabRegistry extends EventEmitter {
  #devices = new Map();
  model = { labs: [], warnings: [], version: 0, error: null };

  constructor({ diagramPath, networkPrefix, isTargetAllowed, logger }) {
    super();
    this.diagramPath = diagramPath;
    this.networkPrefix = networkPrefix;
    this.isTargetAllowed = isTargetAllowed;
    this.log = logger;
  }

  load() {
    try {
      const xml = fs.readFileSync(this.diagramPath, 'utf8');
      const { labs, warnings } = parseDrawio(xml, { networkPrefix: this.networkPrefix });

      // Devices whose console is outside the allow-list stay visible but inert
      const devices = new Map();
      for (const lab of labs) {
        for (const d of lab.devices) {
          d.allowed = this.isTargetAllowed(d.target);
          if (!d.allowed) warnings.push(`${lab.name}/${d.name}: ${d.target.host}:${d.target.port} is outside the allow-list (disabled)`);
          devices.set(d.key, { ...d, labName: lab.name });
        }
      }
      this.#devices = devices;
      this.model = { labs, warnings, version: Date.now(), error: null };
      this.log.info(`Loaded ${labs.length} labs / ${devices.size} devices from ${this.diagramPath}`);
      for (const w of warnings) this.log.warn(w);
    } catch (err) {
      // Keep serving the last good model; surface the error to the UI
      this.model = { ...this.model, error: `Diagram could not be loaded: ${err.message}` };
      this.log.error(this.model.error);
    }
    this.emit('change', this.model);
  }

  watch() {
    let timer;
    fs.watchFile(this.diagramPath, { interval: 2000 }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.load(), 300); // editors write files in several steps
    });
  }

  /** Stop watching the diagram file (shutdown, tests) */
  close() {
    fs.unwatchFile(this.diagramPath);
  }

  getDevice(key) {
    return this.#devices.get(key) || null;
  }
}
