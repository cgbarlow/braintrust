/**
 * Resolution: pasted links in, Sources out.
 *
 * The property under test throughout is that a human never has to know or type a
 * `UC…` channel id, and never has to know which of the six shapes of YouTube link
 * they happen to have copied.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BraintrustError } from '../src/errors.js';
import { resolveLinks } from '../src/sources/resolve.js';
import { CHANNEL_ID, SUBSTACK_HOST, fakeFetcher, natesRoutes } from './support/sources.js';

const deps = () => ({ fetcher: fakeFetcher(natesRoutes()) });

describe('YouTube resolution', () => {
  it('resolves an @handle to its channel id by reading the channel page', async () => {
    const fetcher = fakeFetcher(natesRoutes());
    const [source] = await resolveLinks(['@NateBJones'], { fetcher });

    assert.equal(source!.platform, 'youtube');
    assert.equal(source!.handle, CHANNEL_ID);
    assert.equal(source!.discoveryUrl, `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`);
    // The opaque id is never something a human types or sees.
    assert.equal(source!.resolvedFrom, '@NateBJones');
    assert.deepEqual(fetcher.requests, ['https://www.youtube.com/@NateBJones']);
  });

  it('resolves a link to one video', async () => {
    const fetcher = fakeFetcher(natesRoutes());
    const [source] = await resolveLinks(['https://www.youtube.com/watch?v=abcdefghijk'], { fetcher });

    assert.equal(source!.handle, CHANNEL_ID);
    assert.match(fetcher.requests[0]!, /\/watch\?v=abcdefghijk$/);
  });

  it('treats a youtu.be short link as the watch page it stands for', async () => {
    const fetcher = fakeFetcher(natesRoutes());
    const [source] = await resolveLinks(['https://youtu.be/abcdefghijk'], { fetcher });

    assert.equal(source!.handle, CHANNEL_ID);
    assert.equal(fetcher.requests[0], 'https://www.youtube.com/watch?v=abcdefghijk');
  });

  it('reads the id straight out of a /channel/ link, without a fetch', async () => {
    const fetcher = fakeFetcher(natesRoutes());
    const [source] = await resolveLinks([`https://www.youtube.com/channel/${CHANNEL_ID}`], { fetcher });

    assert.equal(source!.handle, CHANNEL_ID);
    assert.deepEqual(fetcher.requests, []);
  });

  it('reads the id out of a feed URL, without a fetch', async () => {
    const fetcher = fakeFetcher(natesRoutes());
    const [source] = await resolveLinks(
      [`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`],
      { fetcher },
    );

    assert.equal(source!.handle, CHANNEL_ID);
    assert.deepEqual(fetcher.requests, []);
  });

  it('accepts the mobile front end and asks www for the page', async () => {
    const fetcher = fakeFetcher(natesRoutes());
    const [source] = await resolveLinks(['https://m.youtube.com/@NateBJones'], { fetcher });

    assert.equal(source!.handle, CHANNEL_ID);
    assert.equal(fetcher.requests[0], 'https://www.youtube.com/@NateBJones');
  });

  it('accepts a bare channel id, for the person who already has one', async () => {
    const fetcher = fakeFetcher(natesRoutes());
    const [source] = await resolveLinks([CHANNEL_ID], { fetcher });

    assert.equal(source!.handle, CHANNEL_ID);
    assert.deepEqual(fetcher.requests, []);
  });

  it('says so when the page carries no channel id, rather than guessing', async () => {
    const fetcher = fakeFetcher([
      { match: (url) => url.startsWith('https://www.youtube.com/'), body: '<html>sign in</html>' },
    ]);

    await assert.rejects(() => resolveLinks(['@NateBJones'], { fetcher }), (error: Error) => {
      assert.ok(error instanceof BraintrustError);
      assert.match(error.message, /found no channel id/);
      return true;
    });
  });
});

describe('Substack resolution', () => {
  it('resolves a post URL to the publication and its feed, without a fetch', async () => {
    const fetcher = fakeFetcher(natesRoutes());
    const [source] = await resolveLinks([`https://${SUBSTACK_HOST}/p/use-ai-sensitive-files`], { fetcher });

    assert.equal(source!.platform, 'substack');
    assert.equal(source!.handle, SUBSTACK_HOST);
    assert.equal(source!.discoveryUrl, `https://${SUBSTACK_HOST}/feed`);
    assert.deepEqual(fetcher.requests, []);
  });

  it('accepts a bare hostname', async () => {
    const [source] = await resolveLinks([SUBSTACK_HOST], deps());
    assert.equal(source!.handle, SUBSTACK_HOST);
  });

  it('accepts an explicit substack: prefix for a publication name', async () => {
    const [source] = await resolveLinks(['substack:natesnewsletter'], deps());
    assert.equal(source!.handle, SUBSTACK_HOST);
  });

  it('finds a Substack on a custom domain by asking its archive API', async () => {
    const fetcher = fakeFetcher([
      {
        match: (url) => url.startsWith('https://www.platformer.news/api/v1/archive'),
        body: JSON.stringify([{ id: 1, post_date: '2026-01-01T00:00:00Z', audience: 'everyone' }]),
      },
    ]);

    const [source] = await resolveLinks(['https://www.platformer.news/p/something'], { fetcher });

    assert.equal(source!.platform, 'substack');
    assert.equal(source!.handle, 'www.platformer.news');
    assert.equal(fetcher.requests.length, 1);
  });

  /**
   * A host that is neither is not refused for being unrecognised — it is tried as a
   * blog, which is how braintrust does its best with any URL, and refused only when the
   * site declares nothing braintrust can follow. See test/blog.test.ts.
   */
  it('tries an unrecognised host as a blog before refusing it', async () => {
    const fetcher = fakeFetcher([]);
    await assert.rejects(
      () => resolveLinks(['https://example.com/blog'], { fetcher }),
      /could not find a way to follow example\.com/,
    );
  });
});

describe('the links as a set', () => {
  it('collapses two links to the same source into one', async () => {
    const sources = await resolveLinks(
      [`https://${SUBSTACK_HOST}/p/one`, `https://${SUBSTACK_HOST}/p/two`],
      deps(),
    );

    assert.equal(sources.length, 1);
    // The first mention keeps resolved_from: that is the link the human will recognise.
    assert.match(sources[0]!.resolvedFrom, /\/p\/one$/);
  });

  it('keeps both platforms for the same person', async () => {
    const sources = await resolveLinks([`https://${SUBSTACK_HOST}`, '@NateBJones'], deps());
    assert.deepEqual(
      sources.map((source) => source.platform),
      ['substack', 'youtube'],
    );
  });

  it('reports every unusable link at once, not the first', async () => {
    const fetcher = fakeFetcher(natesRoutes());
    await assert.rejects(
      () => resolveLinks(['https://example.com/a', 'https://example.org/b', `https://${SUBSTACK_HOST}`], { fetcher }),
      (error: Error) => {
        assert.match(error.message, /could not use 2 of the 3 links/);
        assert.match(error.message, /example\.com/);
        assert.match(error.message, /example\.org/);
        return true;
      },
    );
  });

  it('says braintrust cannot search when given no links', async () => {
    await assert.rejects(() => resolveLinks([' ', ''], deps()), /cannot find someone from their name/);
  });

  it('asks for a prefix rather than guessing at a bare word', async () => {
    await assert.rejects(() => resolveLinks(['natebjones'], deps()), /substack:natesnewsletter/);
  });
});
