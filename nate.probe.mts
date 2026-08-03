/**
 * Feedback loop for: nate-b-jones fails every compile with
 *   "braintrust could not reach the synthesiser at … while compiling positions: fetch failed"
 *
 * A stand-in for whatever sits in front of api.agentics.org.nz: a server that accepts the
 * request, holds the connection with no bytes flowing, then cuts the socket — which is what
 * an idle/read timeout in a proxy does to a long non-streaming generation.
 *
 * Run: npx tsx <this file> [mode]
 *   idle-drop  (default) — accept, stay silent, destroy the socket. Expect RED.
 *   answers              — accept, reply normally after the same delay. Expect GREEN.
 */

import { createServer, type Server } from 'node:http';
import { createSynthesiser } from './src/compile/index.js';
import { createFetcher } from './src/net/fetch.js';

const MODE = (process.argv[2] ?? 'idle-drop') as 'idle-drop' | 'answers' | 'proxy';
const SILENCE_MS = 400;

/**
 * `proxy` mode is the real thing, scaled down: a reverse proxy that cuts a connection which
 * has gone IDLE_LIMIT_MS without a byte (nginx's proxy_read_timeout, 60s by default), in
 * front of a model that takes GENERATION_MS to produce an answer. A non-streaming request
 * is silent for the whole generation and dies; a streaming one keeps the socket warm.
 */
const IDLE_LIMIT_MS = 300;
const GENERATION_MS = 900;
const STREAM_CHUNK_MS = 100;

const CLUSTER_REPLY = JSON.stringify({
  choices: [
    {
      message: {
        content: JSON.stringify({
          positions: [
            { slug: 'a-position', statement: 'They hold a thing.', claims: ['c1'] },
          ],
        }),
      },
    },
  ],
});

/** The same answer, delivered the way an OpenAI-compatible server streams it. */
function sseChunks(): string[] {
  const content = JSON.stringify({
    positions: [{ slug: 'a-position', statement: 'They hold a thing.', claims: ['c1'] }],
  });
  const pieces: string[] = [];
  for (let at = 0; at < content.length; at += 40) {
    pieces.push(
      `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(at, at + 40) } }] })}\n\n`,
    );
  }
  pieces.push('data: [DONE]\n\n');
  return pieces;
}

function stubEndpoint(): Promise<{ server: Server; url: string; seen: number[] }> {
  const seen: number[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push(body.length);

      if (MODE === 'proxy') {
        const wantsStream = (() => {
          try {
            return JSON.parse(body.toString()).stream === true;
          } catch {
            return false;
          }
        })();

        // The proxy's clock. Reset by every byte the origin sends downstream.
        let idle: NodeJS.Timeout;
        const arm = (): void => {
          clearTimeout(idle);
          idle = setTimeout(() => res.socket?.destroy(), IDLE_LIMIT_MS);
        };
        arm();

        if (!wantsStream) {
          // The origin says nothing until the whole answer exists.
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(CLUSTER_REPLY);
          }, GENERATION_MS);
          return;
        }

        res.writeHead(200, { 'content-type': 'text/event-stream' });
        arm();
        const pieces = sseChunks();
        let i = 0;
        const tick = setInterval(() => {
          if (i >= pieces.length) {
            clearInterval(tick);
            clearTimeout(idle);
            res.end();
            return;
          }
          res.write(pieces[i]!);
          i += 1;
          arm();
        }, STREAM_CHUNK_MS);
        return;
      }

      setTimeout(() => {
        if (MODE === 'idle-drop') {
          // No status line, no bytes: the connection simply stops existing, exactly as a
          // proxy read timeout leaves it.
          res.socket?.destroy();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(CLUSTER_REPLY);
      }, SILENCE_MS);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}/v1`, seen });
    });
  });
}

const { server, url, seen } = await stubEndpoint();

// The real digest budget: a positions pass may carry 120_000 characters.
const digest = `[c1] ${'a claim that says something. '.repeat(4_000)}`;

const synthesiser = createSynthesiser(
  { baseUrl: url, model: 'unsloth/gpt-oss-120b-GGUF', apiKey: 'stub' },
  createFetcher({ timeoutMs: 900_000 }),
  // Keep the transport retry's 2s pause out of the loop's wall clock.
  async () => {},
);

const started = Date.now();
let verdict: string;
let detail: string;

try {
  const positions = await synthesiser.cluster(digest, 'pass');
  verdict = 'GREEN';
  detail = `cluster() returned ${positions.length} position(s)`;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  verdict = message.includes('fetch failed') ? 'RED' : 'RED (different failure)';
  detail = message;
}

console.log(`mode:      ${MODE}`);
console.log(`digest:    ${digest.length.toLocaleString()} chars`);
console.log(`requests:  ${seen.length} (bodies: ${seen.map((n) => `${(n / 1024) | 0}KB`).join(', ')})`);
console.log(`elapsed:   ${Date.now() - started}ms`);
console.log(`verdict:   ${verdict}`);
console.log(`detail:    ${detail}`);

server.close();
