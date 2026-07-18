#!/usr/bin/env node
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const textExtensions = new Set(['.js', '.cjs', '.json', '.md', '.yml', '.yaml', '.txt']);
const findings = [];
const forbiddenCredentialPrefixHash =
  '74f0f71d71864ef09245d0dafe6aba03129017f87ae023a18a1c38bb887ad76c';
const canonicalApacheLicenseSha256 =
  '699a9bdd9d3fb95f2146586a5fb1d7a6a6197a43422914f86869fed84c34222c';

function containsForbiddenCredentialPrefix(text) {
  for (const match of text.matchAll(/(?=([A-Z0-9]{4}-[A-Z0-9]{3}-))/g)) {
    const digest = crypto.createHash('sha256').update(match[1]).digest('hex');
    if (digest === forbiddenCredentialPrefixHash) return true;
  }
  return false;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

for (const relative of trackedFiles()) {
  const absolute = path.join(root, relative);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    findings.push(`${relative}: repository contains a symlink`);
    continue;
  }
  if (!stat.isFile() || (!textExtensions.has(path.extname(relative)) && relative !== 'NOTICE')) {
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

const licenseDigest = crypto
  .createHash('sha256')
  .update(fs.readFileSync(path.join(root, 'LICENSE')))
  .digest('hex');
if (licenseDigest !== canonicalApacheLicenseSha256) {
  findings.push('LICENSE: expected the complete canonical Apache-2.0 text');
}
const packageMetadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (packageMetadata.license !== 'Apache-2.0') {
  findings.push('package.json: license must be Apache-2.0');
}

if (findings.length > 0) {
  for (const finding of findings) console.error(finding);
  throw new Error(`public-surface check found ${findings.length} issue(s)`);
}
console.log('Public-surface check passed.');
