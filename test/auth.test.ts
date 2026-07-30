import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { idFromBody, keyMatches, presentedKey } from '../src/http/auth.js';

describe('presentedKey', () => {
  it('reads ?key=, the documented primary', () => {
    assert.equal(presentedKey({ query: { key: 'sekrit' } }), 'sekrit');
  });

  it('accepts x-access-key, the header OB1 extensions use', () => {
    assert.equal(presentedKey({ headers: { 'x-access-key': 'sekrit' } }), 'sekrit');
  });

  it('prefers the query parameter when both are present', () => {
    assert.equal(
      presentedKey({ query: { key: 'from-query' }, headers: { 'x-access-key': 'from-header' } }),
      'from-query',
    );
  });

  it('tolerates a proxy handing the header over as an array', () => {
    assert.equal(presentedKey({ headers: { 'x-access-key': ['sekrit'] } }), 'sekrit');
  });

  it('does not read x-brain-key, which is OB1 core rather than an extension', () => {
    assert.equal(presentedKey({ headers: { 'x-brain-key': 'sekrit' } }), undefined);
  });

  it('is undefined when nothing was presented', () => {
    assert.equal(presentedKey({ query: {}, headers: {} }), undefined);
  });
});

describe('keyMatches', () => {
  it('accepts the right secret', () => {
    assert.equal(keyMatches('sekrit', 'sekrit'), true);
  });

  it('rejects the wrong secret', () => {
    assert.equal(keyMatches('sekrit', 'wrong'), false);
  });

  it('rejects a secret of a different length without throwing', () => {
    // timingSafeEqual needs equal lengths, so this compares digests instead.
    assert.equal(keyMatches('sekrit', 'a-much-longer-wrong-secret'), false);
  });

  it('rejects a missing secret', () => {
    assert.equal(keyMatches('sekrit', undefined), false);
  });

  it('rejects the empty string', () => {
    assert.equal(keyMatches('sekrit', ''), false);
  });
});

describe('idFromBody', () => {
  it('echoes a numeric id', () => {
    assert.equal(idFromBody({ jsonrpc: '2.0', id: 7, method: 'tools/list' }), 7);
  });

  it('echoes a string id', () => {
    assert.equal(idFromBody({ jsonrpc: '2.0', id: 'abc', method: 'tools/list' }), 'abc');
  });

  it('falls back to null for a notification, a batch, or an unparseable body', () => {
    assert.equal(idFromBody({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    assert.equal(idFromBody([{ jsonrpc: '2.0', id: 1 }]), null);
    assert.equal(idFromBody(undefined), null);
    assert.equal(idFromBody('not json at all'), null);
  });
});
