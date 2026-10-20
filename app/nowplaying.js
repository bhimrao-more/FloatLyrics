/*
 * macOS Now Playing — the track Control Center shows, whichever app plays it (Chrome tabs, Music, Spotify...).
 * Since macOS 15.4 only Apple-entitled processes may read it. mediaremote-adapter gets there through
 * /usr/bin/perl, which is entitled; it is vendored in vendor/mediaremote-adapter (BSD-3-Clause).
 */
const { spawn, execFile } = require('node:child_process');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const DIR = path.join(__dirname, '..', 'vendor', 'mediaremote-adapter');
const SCRIPT = path.join(DIR, 'mediaremote-adapter.pl');
const FRAMEWORK = path.join(DIR, 'MediaRemoteAdapter.framework');
const COMMANDS = { play: 0, pause: 1, toggle: 2, next: 4, previous: 5 }; // MRCommand ids

class NowPlaying extends EventEmitter {
  constructor() {
    super();
    this.state = {};
    this.proc = null;
    this.buffer = '';
    this.stopped = true;
  }

  // Emits 'change' (state, diff) with the merged state after every update the adapter streams.
  start() {
    this.stopped = false;
    const proc = spawn('/usr/bin/perl', [SCRIPT, FRAMEWORK, 'stream', '--micros'], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    this.buffer = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this.read(chunk));
    proc.stderr.on('data', (d) => this.emit('log', String(d).trim()));
    proc.on('exit', (code) => {
      if (this.proc === proc) this.proc = null;
      this.emit('log', `now-playing adapter exited (${code})`);
      if (!this.stopped) setTimeout(() => !this.stopped && !this.proc && this.start(), 2000);
    });
  }

  read(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        continue;
      }
      if (!msg || msg.type !== 'data') continue;
      const diff = msg.payload || {};
      const next = msg.diff ? { ...this.state, ...diff } : { ...diff };
      for (const [k, v] of Object.entries(next)) if (v === null) delete next[k];
      this.state = next;
      this.emit('change', this.state, diff);
    }
  }

  // name: play | pause | toggle | next | previous
  send(name) {
    const id = COMMANDS[name];
    if (id == null) return Promise.reject(new Error(`unknown command ${name}`));
    return new Promise((resolve, reject) => {
      execFile('/usr/bin/perl', [SCRIPT, FRAMEWORK, 'send', String(id)], (err) => (err ? reject(err) : resolve()));
    });
  }

  stop() {
    this.stopped = true;
    if (this.proc) this.proc.kill();
  }
}

module.exports = { NowPlaying };
