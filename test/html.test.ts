/**
 * HTML to text.
 *
 * The nesting case is the one that matters. Substack's subscribe widget is a div
 * containing four more divs, and a non-greedy regex stops at the first `</div>` — which
 * leaves "Subscribe now / Type your email…" sitting in the middle of someone's prose,
 * where the compiler would read it as something they wrote.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dropElements, htmlToText } from '../src/net/html.js';

const WIDGET =
  '<div class="subscription-widget-wrap-editor"><div class="subscription-widget show-subscribe">' +
  '<p class="cta-caption">Subscribe now</p><div class="fake-input-wrapper">' +
  '<div class="fake-input">Type your email…</div></div></div></div>';

describe('extracting a post body', () => {
  it('keeps the prose and drops the furniture, nesting and all', () => {
    const text = htmlToText(`<p>First paragraph.</p>${WIDGET}<p>Second paragraph.</p>`);

    assert.equal(text, 'First paragraph.\n\nSecond paragraph.');
    assert.ok(!text.includes('Subscribe'));
    assert.ok(!text.includes('email'));
  });

  it('decodes entities, so an ampersand is an ampersand', () => {
    assert.equal(
      htmlToText('<p>Nate &amp; Claude &#8212; &quot;quoted&quot; &lt;tag&gt;</p>'),
      'Nate & Claude — "quoted" <tag>',
    );
  });

  it('turns block structure into paragraph breaks', () => {
    const text = htmlToText('<h2>Heading</h2><ul><li>One</li><li>Two</li></ul><p>After<br>a break</p>');
    assert.equal(text, 'Heading\n\nOne\n\nTwo\n\nAfter\na break');
  });

  it('drops scripts and styles entirely', () => {
    const text = htmlToText('<p>Real.</p><script>alert("no")</script><style>p{color:red}</style>');
    assert.equal(text, 'Real.');
  });

  it('never leaves markup or entity syntax behind', () => {
    const text = htmlToText(
      '<div class="post"><p>Text with <em>emphasis</em> and a <a href="https://x">link</a>.</p></div>',
    );
    assert.equal(text, 'Text with emphasis and a link.');
    assert.ok(!/[<>]|&[a-z]+;/i.test(text));
  });

  it('collapses runs of blank lines, which carry no more meaning than one', () => {
    assert.equal(htmlToText('<p>A</p><div></div><div></div><p>B</p>'), 'A\n\nB');
  });

  it('keeps a "Related reading" list, because guessing would delete real prose', () => {
    // Plain h2 and ul with no class to recognise them by, structurally identical to a
    // heading the author wrote. The boilerplate stays; it is a named accepted cost.
    const text = htmlToText('<p>The essay.</p><h2>Related reading</h2><ul><li>Another post</li></ul>');
    assert.match(text, /Related reading/);
  });
});

describe('dropElements', () => {
  it('counts nesting rather than stopping at the first close tag', () => {
    const html = '<div class="keep">A<div class="drop"><div>inner</div>B</div>C</div>';
    assert.equal(dropElements(html, 'div', /drop/), '<div class="keep">AC</div>');
  });

  it('leaves elements whose class does not match', () => {
    const html = '<div class="body">text</div>';
    assert.equal(dropElements(html, 'div', /widget/), html);
  });

  it('drops every occurrence, not just the first', () => {
    const html = `<p>A</p>${WIDGET}<p>B</p>${WIDGET}<p>C</p>`;
    assert.equal(dropElements(html, 'div', /subscription-widget/), '<p>A</p><p>B</p><p>C</p>');
  });

  it('drops the rest rather than leaving half a widget when markup is unbalanced', () => {
    const html = '<p>A</p><div class="subscription-widget">unclosed';
    assert.equal(dropElements(html, 'div', /subscription-widget/), '<p>A</p>');
  });
});
