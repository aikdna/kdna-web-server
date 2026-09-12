import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createKDNAServer, createReferenceHost, readResultResponse } from '../src/index.js';
import { fixture, readRequest, allowAll, upload } from './fixture.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const captures = process.env.KDNA_HOST_EVIDENCE;
if (captures) fs.mkdirSync(captures, { recursive: true, mode: 0o700 });
const measurements = [];
for (const units of [1, 20, 100]) {
  const bytes = fixture(units);
  if (captures) fs.writeFileSync(path.join(captures, `units-${units}.kdna`), bytes, { mode: 0o600 });
  for (const mode of ['exact_selection', 'catalog', 'whole_asset']) {
    const request = readRequest({ mode, selection: mode === 'exact_selection' ? readRequest().selection : null });
    const host = createReferenceHost({ observePolicy: allowAll });
    const elapsed = [];
    let result, wire;
    const rssBefore = process.memoryUsage().rss;
    for (let iteration = 0; iteration < 5; iteration++) {
      const start = performance.now();
      result = await host.read(bytes, request);
      assert.equal(result.envelope?.status, 'ready', JSON.stringify(result));
      wire = Buffer.from(await readResultResponse(result).arrayBuffer());
      elapsed.push(performance.now() - start);
      assert.equal(wire.length, Number(result.envelope.budget.actual_bytes));
      assert.ok(wire.length <= request.budget_bytes);
      assert.equal(result.envelope.states.action_authorization, 'not_evaluated');
      if (mode === 'exact_selection') for (let i = 1; i < units; i++) {
        assert.equal(wire.includes(Buffer.from(`RESULT_SENTINEL_${i}"`)), false);
      }
      if (mode === 'catalog') assert.equal(wire.includes(Buffer.from('RESULT_SENTINEL')), false);
    }
    const server = createKDNAServer({ observePolicy: allowAll });
    const start = performance.now();
    const response = await server.handle(upload('read', bytes, request));
    const httpWire = Buffer.from(await response.arrayBuffer());
    const httpElapsed = performance.now() - start;
    assert.equal(response.status, 200);
    assert.equal(httpWire.length, Number(JSON.parse(httpWire).budget.actual_bytes));
    const record = { units, mode, iterations: elapsed.length, container_bytes: bytes.length, container_sha256: sha(bytes),
      adapter_ms: elapsed, median_ms: [...elapsed].sort((a, b) => a - b)[2], max_ms: Math.max(...elapsed),
      http_request_adapter_ms: httpElapsed, wire_bytes: wire.length, wire_sha256: sha(wire),
      http_wire_bytes: httpWire.length, http_wire_sha256: sha(httpWire),
      closure_nodes: result.envelope.content.closure.length, rss_before: rssBefore,
      rss_after: process.memoryUsage().rss, heap_used_after: process.memoryUsage().heapUsed,
      process_peak_rss_native_units: process.resourceUsage().maxRSS, outcome: 'ready/delivered' };
    measurements.push(record);
    if (captures) {
      fs.writeFileSync(path.join(captures, `units-${units}-${mode}-call.json`), JSON.stringify(result, null, 2));
      fs.writeFileSync(path.join(captures, `units-${units}-${mode}-http.json`), httpWire);
    }
  }
}
console.log(JSON.stringify({ at: new Date().toISOString(), node: process.version,
  platform: process.platform, arch: process.arch, measurements,
  limits: 'Single Node process, five iterations; no load-test, SLA, production Host or remote-client processing claim.' }, null, 2));
