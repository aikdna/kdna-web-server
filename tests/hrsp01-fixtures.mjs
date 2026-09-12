import { fixture, readRequest, allowAll, upload } from './fixture.js';
export { readRequest, allowAll, upload };
export const context = Object.freeze({ trusted: 'server-owned-test-identity' });
export function config(overrides = {}) { return { binding_id: 'binding:test', authorization_domain_id: 'domain:test',
  verifyContext: value => value === context, ...overrides }; }
export function optionalFixture(count = 3) { return fixture(count, p => {
  p.dependencies = Array.from({ length: count - 1 }, (_, index) => index + 1).map(i => ({ id: `dependency:optional:${i}`, producer: { kind: 'judgment_result',
    judgment_ref: `judgment:${i}`, result_contract_ref: `contract:${i}` }, consumer_judgment_ref: 'judgment:0',
    input_role: 'support', data_type: { term: 'result.type.text' }, required: false, purpose: 'Optional support' }));
}); }
export function mandatoryFixture() { return fixture(2, p => {
  p.dependencies = [{ id: 'dependency:mandatory', producer: { kind: 'judgment_result', judgment_ref: 'judgment:1',
    result_contract_ref: 'contract:1' }, consumer_judgment_ref: 'judgment:0', input_role: 'support',
    data_type: { term: 'result.type.text' }, required: true, purpose: 'Mandatory support' }];
}); }
export const settings = { context, deliverResponse: () => true };
export const tick = () => new Promise(resolve => setImmediate(resolve));
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
