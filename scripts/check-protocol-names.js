#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const textExtensions = new Set(['.js', '.cjs', '.json', '.md', '.yml', '.yaml', '.txt']);
const retired = [
  ['retired manifest discriminator', /kdna_version/],
  ['retired judgment profile', /judgment-profile-v1/i],
  ['retired Capsule discriminator', /kdna\.context\.capsule/i],
  ['generation-shaped entitlement route', /\/v1\/entitlements\/(?:activate|sync|status|revoke)/i],
  ['generation-style integer label', /(?:^|[^A-Za-z0-9.])[Vv][0-9]+(?![0-9.])/],
  ['generation suffix on a KDNA-owned name', /\bkdna[a-z0-9_.:-]*[-_.]v[0-9]+(?![0-9.])/i],
];
const findings = [];

function allowedThirdPartyReference(relative, line) {
  return relative === 'CODE_OF_CONDUCT.md' && /contributor-covenant\.org\/version\//.test(line);
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

for (const relative of trackedFiles()) {
  if (!textExtensions.has(path.extname(relative))) continue;
  if (relative === 'scripts/check-protocol-names.js') continue;
  const absolute = path.join(root, relative);
    const bytes = fs.readFileSync(absolute);
    if (bytes.length > 1_000_000 || bytes.includes(0)) continue;
    const lines = bytes.toString('utf8').split(/\r?\n/);
    lines.forEach((rawLine, index) => {
      if (allowedThirdPartyReference(relative, rawLine)) return;
      const line = rawLine.replace(/("integrity"\s*:\s*")[^"]+(")/g, '$1<opaque digest>$2');
      for (const [rule, pattern] of retired) {
        pattern.lastIndex = 0;
        if (pattern.test(line)) findings.push(`${relative}:${index + 1}: ${rule}`);
      }
    });
}

if (findings.length > 0) {
  for (const finding of findings) console.error(finding);
  throw new Error(`protocol naming gate found ${findings.length} issue(s)`);
}
console.log('Protocol naming gate passed.');
