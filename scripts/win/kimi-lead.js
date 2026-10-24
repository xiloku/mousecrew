#!/usr/bin/env node
// kimi-lead.js — lets mousecrew-worker drive Kimi Code CLI as the "lead" seat.
// mousecrew-worker calls:  <cli> -p <text> --output-format text --dangerously-skip-permissions [--model M]
// Kimi's text mode also prints its reasoning, and it has no --dangerously-skip-permissions,
// so this shim takes the -p text, runs kimi in stream-json mode under a clean KIMI_CODE_HOME,
// and prints only the assistant's final content.
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const i = argv.indexOf('-p');
const prompt = i >= 0 ? argv[i + 1] : '';
const mi = argv.indexOf('--model');
const model = process.env.KIMI_LEAD_MODEL || (mi >= 0 ? argv[mi + 1] : 'kimi-code/k3.1-pro');
if (!prompt) { console.error('kimi-lead: no -p prompt'); process.exit(2); }

const env = { ...process.env, KIMI_CODE_HOME: process.env.KIMI_CODE_HOME || 'C:\\Users\\Admin\\.kimi-worker' };
const kimi = process.env.KIMI_EXE || 'C:\\Users\\Admin\\.kimi-code\\bin\\kimi.exe';
const proc = spawn(kimi, ['-m', model, '-p', prompt, '--output-format', 'stream-json'], { env, stdio: ['ignore', 'pipe', 'pipe'] });

let buf = '';
const parts = [];
proc.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) parts.push(m.content);
    } catch { /* not json */ }
  }
});
let err = '';
proc.stderr.on('data', (d) => { err += d.toString(); });
proc.on('close', (code) => {
  if (parts.length) process.stdout.write(parts[parts.length - 1].trim() + '\n');
  if (code !== 0) process.stderr.write(err.slice(-400));
  process.exit(code === 0 && parts.length ? 0 : (code || 1));
});
