import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const source = readFileSync(process.argv[2] ?? '../inputs/public-semantic-source.json');
assert.equal(createHash('sha256').update(source).digest('hex'), '8082f06ae3cbcb0c850d2eb631df331225603e4943cf49c51c1eaae661ff3297');
const p = JSON.parse(source).engineering.host_retained_session_profile;
const projected = { contract: p.contract, limits: p.limits, options: p.host_configuration.options_type };
const expected = '// Generated from public-semantic-source.json /engineering/host_retained_session_profile.\n'
  + '// Source SHA-256: 8082f06ae3cbcb0c850d2eb631df331225603e4943cf49c51c1eaae661ff3297\n'
  + 'export const retainedProfile = Object.freeze(' + JSON.stringify(projected, null, 2) + ');\n';
assert.equal(readFileSync('src/profile.js', 'utf8'), expected);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(pkg.version, '0.4.0-rc.host-session.1');
assert.deepEqual(pkg.peerDependencies, { '@aikdna/kdna-core': '0.23.0', '@aikdna/kdna-read': '0.2.0' });
assert.deepEqual(Object.keys(pkg.exports), ['.', './express', './nextjs']);
for (const file of ['src/runtime.js','src/retained.js','src/index.js','src/adapters/express/index.js','src/adapters/nextjs/index.js']) {
  const text = readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /@aikdna\/kdna-(?:core|read)\/(?:src|schema)/);
}
console.log('Exact HRSP01 profile projection, version, peers and public imports match.');

const declarations = readFileSync('src/index.d.ts', 'utf8');
const required = Object.entries(p.host_configuration.options_type.required).map(([key, type]) =>
  '  readonly ' + key + ': ' + (type === 'Identifier' ? 'string' : '(context: C) => boolean | Promise<boolean>') + ';').join('\n');
const optional = Object.keys(p.host_configuration.options_type.optional).map(key => '  readonly ' + key + '?: number;').join('\n');
const optionType = 'export interface RetainedReadSessionOptions<C = unknown> {\n' + required + '\n' + optional + '\n}';
const stateFields = Object.entries(p.host_surface.retention_state.fields).map(([key, type]) =>
  '  readonly ' + key + ': ' + (Array.isArray(type) ? type.map(value => "'" + value + "'").join(' | ') : 'number') + ';').join('\n');
const stateType = 'export interface RetainedReadSessionState {\n' + stateFields + '\n}';
assert.ok(declarations.includes(optionType)); assert.ok(declarations.includes(stateType));
console.log('Closed retained options and state declarations match the sole machine profile.');
