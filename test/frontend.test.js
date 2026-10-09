import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as acorn from 'acorn';

const read = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');

// These guard the iOS 12 Safari constraint. Each item is either newer syntax or
// a browser API that Safari 12 does not have.
test('the page script parses as ES5, the newest syntax iOS 12 Safari reliably runs', () => {
  assert.doesNotThrow(() => acorn.parse(read('app.js'), { ecmaVersion: 5 }));
});

test('the page script avoids browser APIs that iOS 12 Safari lacks', () => {
  const source = read('app.js');
  const banned = [
    /\breplaceAll\b/,
    /\.at\(/,
    /\bhasOwn\b/,
    /\bstructuredClone\b/,
    /\bfindLast\b/,
    /\bmatchAll\b/,
    /\bResizeObserver\b/,
    /\brandomUUID\b/,
    /\breplaceChildren\b/,
    /\bAbortSignal\.timeout\b/,
  ];
  for (const pattern of banned) {
    assert.doesNotMatch(source, pattern, `app.js uses ${pattern}`);
  }
});

test('the stylesheet avoids CSS that iOS 12 Safari ignores', () => {
  // Comments can name the things we avoid, so only the rules themselves are checked.
  const css = read('style.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const banned = [
    /(^|[^-\w])gap\s*:/m,
    /\brow-gap\s*:/,
    /\bcolumn-gap\s*:/,
    /\binset\s*:/,
    /aspect-ratio/,
    /clamp\(/,
    /var\(--/,
    /:is\(/,
    /:where\(/,
    /(?<!-webkit-)backdrop-filter/,
    /position:\s*sticky/,
    /\benv\(/,
  ];
  for (const pattern of banned) {
    assert.doesNotMatch(css, pattern, `style.css uses ${pattern}`);
  }
});

test('the frontend only talks to its own server, so it works on a LAN with no internet', () => {
  for (const name of ['index.html', 'app.js', 'style.css']) {
    assert.doesNotMatch(read(name), /https?:\/\//, `${name} references an external address`);
  }
});

test('the page declares the iOS home-screen and viewport settings', () => {
  const html = read('index.html');
  assert.match(html, /name="viewport"[^>]*width=device-width/);
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /<script src="app\.js"><\/script>/);
});
