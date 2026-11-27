import assert from 'node:assert/strict';
import test from 'node:test';
import {Readable} from 'node:stream';
import {createSophieCallback} from '../src/agents/trade/trade-sophie-callback.mjs';
const secret='fixture-status-secret-0000000000000000000',id='a'.repeat(64),did='0359111403',businessId='biz';
const response=()=>({destroyed:false,writeHead(code){this.code=code;},end(body){this.body=JSON.parse(body);}});
function status(service,overrides={}){const res=response();service.status({method:'GET',url:`/sophie-callback/status?id=${id}&did=${did}&businessId=${businessId}`,headers:{authorization:`Bearer ${secret}`},...overrides},res);return res;}
test('authenticated status reads never originate; pending results are not reported as answered',async()=>{
 let finishDial,dials=0;
 const service=createSophieCallback({env:{BMSPRO_CALLBACK_ENABLED:'true',BMSPRO_CALLBACK_AMI_USER:'fixture',BMSPRO_CALLBACK_AMI_SECRET:'fixture'},bridgeSecret:secret,resolveRoute:async()=>({mode:'trade',businessId,did,callback:{callerId:did,dialPrefix:''}}),hasCapacity:()=>true,dial:()=>{dials++;return new Promise(resolve=>{finishDial=resolve;});}});
 assert.equal(status(service).code,404);assert.equal(dials,0);
 const request=Readable.from([JSON.stringify({id,did,businessId,number:'0412345678',customerName:'Fixture'})]);request.method='POST';request.headers={authorization:`Bearer ${secret}`};
 const res=response(),pending=service.handle(request,res,'overdue_invoice');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(status(service).body.status,'REQUESTED');assert.equal(dials,1);
 assert.equal(status(service,{headers:{authorization:'Bearer wrong'}}).code,401);
 assert.equal(status(service,{url:`/sophie-callback/status?id=${id}&did=${did}&businessId=other`}).code,404);
 finishDial('ANSWERED');await pending;
 assert.equal(status(service).body.status,'ANSWERED');assert.equal(status(service).body.id,id);assert.equal(dials,1);
 assert.equal(JSON.stringify(status(service).body).includes('0412345678'),false);
});
