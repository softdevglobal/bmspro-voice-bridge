import {readFile} from 'node:fs/promises';
export async function loadAudioProviderConfig(env=process.env) {
  const provider=env.BMSPRO_AUDIO_PROVIDER||'gpt-live';
  if(!['gpt-live','deepgram'].includes(provider))throw new Error('Invalid BMSPRO_AUDIO_PROVIDER.');
  if(provider==='gpt-live')return {provider,dids:new Set()};
  // Omitted filter means all backend-resolved Trade tenants. An explicit list
  // remains available for controlled rollouts; it never determines tenant identity.
  const dids=env.BMSPRO_DEEPGRAM_DIDS_JSON?.trim()
    ? JSON.parse(env.BMSPRO_DEEPGRAM_DIDS_JSON) : null;
  if(dids!==null&&(!Array.isArray(dids)||!dids.length||dids.some(d=>typeof d!=='string'||!/^\d{6,15}$/.test(d))||new Set(dids).size!==dids.length))
    throw new Error('Optional Deepgram DID filter must contain unique valid DIDs.');
  const key=(env.DEEPGRAM_API_KEY_FILE?await readFile(env.DEEPGRAM_API_KEY_FILE,'utf8'):env.DEEPGRAM_API_KEY||'').trim();
  if(!key||/[\r\n]/.test(key))throw new Error('Inject DEEPGRAM_API_KEY from the secret manager.');
  return {provider,dids:dids===null?null:new Set(dids),key};
}
export const useDeepgram=(config,route)=>config.provider==='deepgram'&&route?.mode==='trade'&&
  typeof route.did==='string'&&/^\d{6,15}$/.test(route.did)&&
  (config.dids===null||config.dids.has(route.did));
