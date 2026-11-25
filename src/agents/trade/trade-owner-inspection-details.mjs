export function ownerInspectionDetailsTool(config, outbound, fetcher=fetch) {
  if (outbound?.purpose !== 'owner_notification' || config.mode !== 'trade') return undefined;
  return {
    tool:{type:'function',name:'get_notified_inspection',strict:false,
      description:'Read the inspection linked to this owner notification call when the owner asks for details. Read only; no search or changes.',
      parameters:{type:'object',properties:{},additionalProperties:false}},
    call:async(name,args)=>{
      const unavailable={status:'UNAVAILABLE',message:'Inspection details could not be verified. Ask the owner to open Trade; do not invent details.'};
      if (name!=='get_notified_inspection' || !args || typeof args!=='object' || Array.isArray(args) || Object.keys(args).length) return unavailable;
      try {
        const url=new URL(config.url);
        if (!/^\/api\/ai\/mcp\/?$/.test(url.pathname)) return unavailable;
        url.pathname='/api/ai/callbacks/owner-inspection';url.search='';url.hash='';
        const response=await fetcher(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{
          Authorization:`Bearer ${config.token}`,'Content-Type':'application/json','X-BMSPro-DID':config.did,
          'X-BMSPro-Trade-Business':config.businessId,'X-BMSPro-Caller-Number':outbound.number,
        },body:JSON.stringify({attemptId:outbound.attemptId})});
        if (!response.ok) return unavailable;
        const result=await response.json();
        return result?.status==='OK' && result.inspection?.requestCode===outbound.ownerNotification?.requestCode ? result : unavailable;
      } catch {return unavailable;}
    },
  };
}
