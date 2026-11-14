import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

function walk(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() ? [path] : [];
  });
}

const requirementFiles = walk(join(root, 'docs/prd')).filter((path) => path.endsWith('.md'));
const testFiles = walk(join(root, 'packages')).filter((path) => path.endsWith('.test.ts'));

const requirements = new Map();
const tests = new Map();

for (const path of requirementFiles) {
  const text = readFileSync(path, 'utf8');
  for (const match of text.matchAll(/\[REQ-(\d+)-(\d+)\]/g)) {
    requirements.set(`REQ-${match[1]}-${match[2]}`, path);
  }
}

for (const path of testFiles) {
  const text = readFileSync(path, 'utf8');
  for (const match of text.matchAll(/\[TC-(\d+)-(\d+)-(\d+)\]/g)) {
    const id = `TC-${match[1]}-${match[2]}-${match[3]}`;
    const requirement = `REQ-${match[1]}-${match[2]}`;
    const previous = tests.get(id);
    if (previous) {
      tests.set(id, { requirement, path, duplicate: previous.path });
    } else {
      tests.set(id, { requirement, path });
    }
  }
}

const covered = new Set([...tests.values()].map((test) => test.requirement));
const missing = [...requirements.keys()].filter((id) => !covered.has(id));
const orphans = [...tests.entries()]
  .filter(([, test]) => !requirements.has(test.requirement))
  .map(([id]) => id);
const duplicates = [...tests.entries()]
  .filter(([, test]) => test.duplicate)
  .map(([id, test]) => `${id} in ${test.path} and ${test.duplicate}`);

console.log(`requirements: ${requirements.size}`);
console.log(`tests: ${tests.size}`);
if (missing.length) console.log(`missing tests: ${missing.join(', ')}`);
if (orphans.length) console.log(`orphan tests: ${orphans.join(', ')}`);
if (duplicates.length) console.log(`duplicate tests:\n${duplicates.join('\n')}`);

if (missing.length || orphans.length || duplicates.length) process.exit(1);
