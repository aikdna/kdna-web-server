#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excluded = new Set(['.git', 'node_modules']);
const textExtensions = new Set(['.js', '.cjs', '.json', '.md', '.yml', '.yaml', '.txt']);
const findings = [];
const forbiddenCredentialPrefixHash =
  '74f0f71d71864ef09245d0dafe6aba03129017f87ae023a18a1c38bb887ad76c';

function containsForbiddenCredentialPrefix(text) {
  for (const match of text.matchAll(/(?=([A-Z0-9]{4}-[A-Z0-9]{3}-))/g)) {
    const digest = crypto.createHash('sha256').update(match[1]).digest('hex');
    if (digest === forbiddenCredentialPrefixHash) return true;
  }
  return false;
}

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (entry.isSymbolicLink()) {
      findings.push(`${relative}: repository contains a symlink`);
      continue;
    }
    if (entry.isDirectory()) {
      visit(absolute);
      continue;
    }
    if (!entry.isFile() || (!textExtensions.has(path.extname(entry.name)) && entry.name !== 'NOTICE')) {
      continue;
    }
    const bytes = fs.readFileSync(absolute);
    if (bytes.length > 1_000_000 || bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    if (/\/Users\/(?!<user>\/|you\/|username\/)[^/\s]+\//.test(text)) {
      findings.push(`${relative}: machine-specific filesystem path`);
    }
    if (containsForbiddenCredentialPrefix(text)) {
      findings.push(`${relative}: credential prefix or token-shaped example`);
    }
    if (/(?:^|\/)(?:AGENTS|WORKLOG)\.md$/i.test(relative)) {
      findings.push(`${relative}: private coordination file`);
    }
  }
}

visit(root);
if (findings.length > 0) {
  for (const finding of findings) console.error(finding);
  throw new Error(`public-surface check found ${findings.length} issue(s)`);
}
console.log('Public-surface check passed.');
