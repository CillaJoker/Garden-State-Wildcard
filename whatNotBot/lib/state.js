import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATE_DIR = path.join(ROOT, 'state');

const fileFor = (target) => path.join(STATE_DIR, `${target}.json`);

// { target, results: { username: 'followed'|'already'|'failed'|'skipped' } }
export function load(target) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(target), 'utf8'));
  } catch {
    return { target, results: {} };
  }
}

export function save(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(fileFor(state.target), JSON.stringify(state, null, 2));
}

export function isDone(state, username) {
  const r = state.results[username];
  return r === 'followed' || r === 'already';
}

export function record(state, username, result) {
  state.results[username] = result;
  save(state);
}
