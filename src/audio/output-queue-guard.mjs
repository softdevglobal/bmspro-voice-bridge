/** Provider-generated speech may arrive faster than real-time telephone playback.
 * Bound memory separately from a genuinely stalled media path. PCMU is 8 kB/s.
 */
export function createOutputQueueGuard({deepgram=false,now=()=>performance.now()}={}) {
 const maxBytes=(deepgram?60:10)*8000,stallMs=10000;
 let lastProgress=null;
 return {
  append(bufferedBytes,chunkBytes){
   if(bufferedBytes+chunkBytes>maxBytes)return 'OUTPUT_AUDIO_BACKLOG';
   if(bufferedBytes===0)lastProgress=now();
   return null;
  },
  drained(remainingBytes){lastProgress=remainingBytes>0?now():null;},
  clear(){lastProgress=null;},
  check(bufferedBytes){return bufferedBytes>0&&lastProgress!==null&&now()-lastProgress>=stallMs?'OUTPUT_PLAYBACK_STALLED':null;},
 };
}
