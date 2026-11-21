/**
 * Live context appends accept at most 500 tokens each. A conservative 400-byte
 * UTF-8 ceiling stays below that limit even for text with poor token compression.
 * Preserve all content, in order, without cutting a Unicode code point.
 */
export const LIVE_CONTEXT_MAX_BYTES = 400;
export function splitLiveContext(content) {
  if (typeof content !== 'string') throw new TypeError('Live context must be text.');
  const chunks = [];
  let chunk = '', bytes = 0;
  for (const char of content) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > LIVE_CONTEXT_MAX_BYTES) {
      // Prefer a word boundary, but support arbitrarily long words/identifiers.
      const boundary = Math.max(chunk.lastIndexOf(' '), chunk.lastIndexOf('\n')) + 1;
      if (boundary > chunk.length / 2) {
        chunks.push(chunk.slice(0, boundary)); chunk = chunk.slice(boundary);
      } else { chunks.push(chunk); chunk = ''; }
      bytes = Buffer.byteLength(chunk, 'utf8');
    }
    chunk += char; bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function sendLiveContext(live, event) {
  if (!['session.instructions.append', 'session.commentary.append', 'session.thinking.append'].includes(event.type)) {
    throw new TypeError('Unsupported Live context event.');
  }
  const chunks = splitLiveContext(event.content);
  for (let index = 0; index < chunks.length; index++) {
    live.send({...event, content: chunks[index],
      ...(event.event_id && {event_id: chunks.length === 1 ? event.event_id : `${event.event_id}_${index + 1}`})});
  }
  return chunks.length;
}
