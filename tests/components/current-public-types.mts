import {createReferenceHost,type HostValidationResult,type ReferenceHost} from '@aikdna/kdna-web-server';
import type {CoreStaticStates,CoreComponentFailure} from '@aikdna/kdna-core';
const h:ReferenceHost=createReferenceHost();
const result:HostValidationResult=await h.validate(new Uint8Array());
if(result.valid){const exact:true=result.valid;const notEvaluated:'not_evaluated'=result.action_authorization;void exact;void notEvaluated;}
else{const states:CoreStaticStates=result.states;const failure:CoreComponentFailure|null=result.component_failure;const code:string=result.code;void states;void failure;void code;}
// Existing callers can still project the original validation surface.
const compatible:Readonly<{valid:boolean;code?:string;action_authorization:'not_evaluated'}>=result;void compatible;
// @ts-expect-error Host validation cannot grant action permission.
const authorized:'authorized'=result.action_authorization;void authorized;
h.dispose();
