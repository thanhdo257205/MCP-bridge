import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowToken, tokenNotice } from '../src/login-notice.js';

const token = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDEF';

test('token notice: contains the token once, a warning, and works with and without color', () => {
  for (const color of [true, false]) {
    const text = tokenNotice(token, {color, firstRun: true}).join('\n');
    assert.equal(text.split(token).length - 1, 1);
    assert.match(text, /do not share screenshots/);
    assert.match(text, /--show-token/);
    assert.equal(text.includes('\u001b['), color, 'escape codes only when color is on');
  }
  assert.match(tokenNotice(token, {color: false, firstRun: true}).join('\n'), /just created/);
  assert.match(tokenNotice(token, {color: false, firstRun: false}).join('\n'), /because of --show-token/);
});

test('token notice: shown for a new token or on request, never when redirected or when the token comes from the environment', () => {
  const base = {created: false, requested: false, fromFile: true, interactive: true};
  assert.equal(shouldShowToken({...base}), false, 'an existing token is not repeated by default');
  assert.equal(shouldShowToken({...base, created: true}), true, 'first run');
  assert.equal(shouldShowToken({...base, requested: true}), true, '--show-token');
  assert.equal(shouldShowToken({...base, created: true, interactive: false}), false, 'logs and CI never get the token');
  assert.equal(shouldShowToken({...base, requested: true, interactive: false}), false);
  assert.equal(shouldShowToken({...base, created: true, fromFile: false}), false, 'BRIDGE_HTTP_TOKEN');
});
