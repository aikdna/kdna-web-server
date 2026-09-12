import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dependencyVersions, componentContract } from '../src/current-core.js';
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const binding = JSON.parse(readFileSync(new URL('../docs/current-core-read-binding.json', import.meta.url)));
assert.equal(pkg.version,binding.host_version);
assert.equal(componentContract.definition_digest,binding.component_definition_digest);
assert.deepEqual(pkg.peerDependencies,{'@aikdna/kdna-core':dependencyVersions.core,'@aikdna/kdna-read':dependencyVersions.read});
for (const a of binding.archives) {
 const bytes = readFileSync(new URL('../vendor/'+a.file,import.meta.url));
 assert.equal(bytes.length,a.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'),a.sha256);
 assert.equal('sha512-'+createHash('sha512').update(bytes).digest('base64'),a.integrity);
 const installed=JSON.parse(readFileSync(new URL('../node_modules/'+a.name+'/package.json',import.meta.url)));
 assert.equal(installed.version,a.version);
}
assert.deepEqual(Object.keys(pkg.exports),['.','./express','./nextjs']);
console.log('Current Host public graph versions, descriptor, archive hashes/integrities and exports match.');
