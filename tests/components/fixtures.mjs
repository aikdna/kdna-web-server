import fs from 'node:fs';
import { encode, decode } from 'cbor-x';
import { zip } from '../fixture.js';
import { admitNode } from '@aikdna/kdna-core/node';
import { inspectSnapshot } from '@aikdna/kdna-core/read-boundary';
export const bytesFor=name=>fs.readFileSync(new URL('./fixtures/'+name,import.meta.url));
export const context=Object.freeze({fixture:'server-owned-context'});
export const retained={binding_id:'binding:components',authorization_domain_id:'domain:components',verifyContext:value=>value===context};
export const settings={context,deliverResponse:()=>true};
export const allowAll=({snapshot})=>({decision:'allow',scope:snapshot.ir.nodes.map(n=>n.id),epoch:'epoch:components',policyId:'policy:fixture'});
export async function inspect(bytes){const result=await admitNode(bytes);if(result.status!=='accepted')throw Error(JSON.stringify(result));return inspectSnapshot(result.snapshot);}
export async function request(bytes,id,overrides={}){const view=await inspect(bytes);return {request_id:id,tuple:view.tuple,budget_bytes:1000000,mode:'exact_selection',selection:{asset_id:view.asset.asset_id,asset_version:view.asset.asset_version,judgment_id:view.ir.nodes.find(n=>n.role==='judgment').owner_judgment_id},handle:null,...overrides};}
export function upload(operation,bytes,candidate){const form=new FormData();form.set('file',new Blob([bytes]),'synthetic.kdna');if(operation!=='validate')form.set('request',JSON.stringify(candidate));return new Request('http://synthetic.invalid/api/kdna/'+operation,{method:'POST',body:form});}
// This fixture-only stored-ZIP reader never runs in the Host package. It adds
// one optional support judgment without altering the inherited component declarations.
export function withOptionalSupport(){
 const b=bytesFor('independent-mechanisms.kdna'),entries=[];let offset=0;
 while(b.readUInt32LE(offset)===0x04034b50){const method=b.readUInt16LE(offset+8),size=b.readUInt32LE(offset+18),nl=b.readUInt16LE(offset+26),xl=b.readUInt16LE(offset+28);if(method!==0)throw Error('Fixture ZIP must be stored');const name=b.subarray(offset+30,offset+30+nl).toString(),start=offset+30+nl+xl;entries.push([name,b.subarray(start,start+size)]);offset=start+size;}
 const payloadEntry=entries.find(x=>x[0]==='payload.kdnab'),p=decode(payloadEntry[1]);
 const id='judgment:optional-support',contract='contract:optional-support';
 p.judgments.push({id,label:'Optional support',focus:'Host expand fixture',subject:{actor_ids:[p.actors[0].id],statement:'Optional supporting judgment'},scope:{statement:'Only this synthetic Host exercise'},result_contract:{id:contract,form:{term:'result.form.assertion'},shape:{kind:'scalar',scalar_type:'text'},minimum:1,maximum:1,allowed_result_types:[{term:'result.type.text'}]},result:{contract_ref:contract,result_type:{term:'result.type.text'},value:{kind:'text',value:'OPTIONAL_COMPONENT_HOST_SUPPORT'}}});
 p.dependencies=[...(p.dependencies??[]),{id:'dependency:optional-component-support',producer:{kind:'judgment_result',judgment_ref:id,result_contract_ref:contract},consumer_judgment_ref:p.judgments[0].id,input_role:'support',data_type:{term:'result.type.text'},required:false,purpose:'Optional support for retained expand exercise'}];
 payloadEntry[1]=encode(p);return zip(entries);
}
