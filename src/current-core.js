import { createRequire } from 'node:module';
import { getComponentSemanticsContract } from '@aikdna/kdna-core/components';
const require = createRequire(import.meta.url);
export const dependencyVersions = Object.freeze({ core: '0.24.0-rc.component-semantics.2', read: '0.3.0-rc.component-semantics.2' });
if (require('@aikdna/kdna-core/package.json').version !== dependencyVersions.core
  || require('@aikdna/kdna-read/package.json').version !== dependencyVersions.read) {
  throw new Error('KDNA reference Host requires exact Core 0.24.0-rc.component-semantics.2 and Read 0.3.0-rc.component-semantics.2.');
}
export const componentContract = getComponentSemanticsContract();
if (componentContract.definition_digest !== 'sha256:3087cd19542e72322aec19b3015c916d2cfb074fa42e3fd76b3756bb4f097de3') {
  throw new Error('KDNA reference Host component definition does not match its current public graph.');
}
// Preserve the Host admission gate. Rejected public Core state is not inferred from the boolean.
export function validationProjection(admitted) {
  return Object.freeze(admitted.status === 'accepted'
    ? { valid: true, action_authorization: 'not_evaluated' }
    : { valid: false, code: admitted.reason, action_authorization: 'not_evaluated',
      states: admitted.states, diagnostics: admitted.diagnostics, component_failure: admitted.component_failure });
}
