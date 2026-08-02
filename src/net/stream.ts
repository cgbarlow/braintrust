/**
 * Reading a chat answer that arrived as a stream.
 *
 * **braintrust streams for the connection, not for the display.** Nothing here shows a token
 * to anybody: both callers read the whole answer before they do anything with it. What the
 * stream buys is bytes on the wire while a model is thinking — and that is the difference
 * between a long pass finishing and a long pass dying.
 *
 * A request that is not streamed sends nothing at all between the last byte of the prompt and
 * the first byte of the finished answer. For a note over a 40,000-word item, or a synthesis
 * pass carrying a whole corpus of claims, that silence runs to minutes. Every reverse proxy
 * has a read timeout — nginx's default is 60 seconds — and a connection that quiet is cut.
 * The client sees no status and no refusal, only `fetch failed`, which is indistinguishable
 * from the endpoint being switched off and is not something a run can act on.
 *
 * Found live: the largest Corpus in a council failed its rebuild four runs running while every
 * smaller Person compiled over the same endpoint in the same run.
 *
 * Both shapes are read, because `stream: true` is a request braintrust makes rather than a
 * promise the endpoint gives. A server free to ignore it answers with the whole object, and
 * that answer is still correct.
 */

/**
 * Whether a body is a stream of events rather than one object.
 *
 * The first line that carries anything decides, and a stream's first line is often the
 * keep-alive comment rather than an event — which is the whole point of it: a proxy that would
 * otherwise time out sees a byte before the model has produced a token. Reading only for
 * `data:` would misfile exactly the answer this stream exists to protect.
 */
export function isEventStream(body: string): boolean {
  const first = body.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
  return /^(data:|event:|id:|retry:|:)/.test(first);
}

type ChatEvent = { choices?: { delta?: { content?: unknown }; message?: { content?: unknown } }[] };

/**
 * The content of a streamed answer, joined back into the string it would have been.
 *
 * Deltas are concatenated in arrival order — that is what a stream *is*, and reordering or
 * de-duplicating them would invent an answer nobody generated. A server that streams whole
 * messages rather than deltas is read too, because some do.
 *
 * A malformed event is skipped rather than fatal. Each caller checks that what arrived parses
 * as the JSON object it asked for, which is the check that matters; failing here instead would
 * turn one dropped keep-alive line into a lost Compile.
 */
export function joinStream(body: string): string {
  let content = '';
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;

    const payload = trimmed.slice('data:'.length).trim();
    if (payload === '' || payload === '[DONE]') continue;

    let event: ChatEvent;
    try {
      event = JSON.parse(payload) as ChatEvent;
    } catch {
      continue;
    }

    const choice = event.choices?.[0];
    const piece = choice?.delta?.content ?? choice?.message?.content;
    if (typeof piece === 'string') content += piece;
  }
  return content;
}
