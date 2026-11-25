export const OWNER_PHONE_READ_NAMES=Object.freeze(['get_customer_call_history','lookup_customer_jobs','suggest_scheduling','list_quote_follow_ups',
  'get_sophie_call_summaries','get_daily_summary','get_day_activity','get_staff_day_report','list_invoices',
  'list_overdue_invoices','list_missed_calls','list_jobs_awaiting_scheduling','get_staff_working_today']);
export async function openOwnerPhoneBriefing(config,outbound,fetcher=fetch) {
  const unavailable={status:'UNAVAILABLE',message:'The business lookup is unavailable. Do not guess; ask the owner to check Trade.'};
  if(config.mode!=='trade'||outbound?.purpose!=='owner_notification')return {tools:[],call:async()=>unavailable};
  const request=async payload=>{
    const url=new URL(config.url);
    if(!/^\/api\/ai\/mcp\/?$/.test(url.pathname))return null;
    url.pathname='/api/ai/callbacks/owner-briefing';url.search='';url.hash='';
    const response=await fetcher(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(payload.tool?30000:4000),headers:{
      Authorization:`Bearer ${config.token}`,'Content-Type':'application/json','X-BMSPro-DID':config.did,
      'X-BMSPro-Trade-Business':config.businessId,'X-BMSPro-Caller-Number':outbound.number,
    },body:JSON.stringify({attemptId:outbound.attemptId,...payload})});
    return response.ok?response.json():null;
  };
  let listed;
  try{listed=await request({});}catch{/* The inspection notification still works without briefing reads. */}
  const tools=listed?.status==='OK'&&Array.isArray(listed.tools)?listed.tools.filter(tool=>
    OWNER_PHONE_READ_NAMES.includes(tool?.name)&&tool.type==='function'&&typeof tool.description==='string'&&tool.parameters?.type==='object'):[];
  return {tools,call:async(name,args)=>{
    if(!tools.some(tool=>tool.name===name)||!args||typeof args!=='object'||Array.isArray(args)||'followUp' in args)return {status:'REJECTED'};
    try{const response=await request({tool:name,args});return response?.status==='OK'?response.result:unavailable;}catch{return unavailable;}
  }};
}
