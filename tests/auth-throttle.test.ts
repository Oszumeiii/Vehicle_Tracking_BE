import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LoginThrottle } from '../src/auth/throttle';

test('login throttle refuses a key after max failures until the oldest leaves the window', () => {
  let now = 0;
  const throttle = new LoginThrottle(3, 60_000, () => now);
  for (let i = 0; i < 3; i++) {
    assert.equal(throttle.retryAfter('a'), 0);
    throttle.fail('a');
    now += 10_000;
  }
  // Failures at 0, 10 and 20 s; at 30 s the first one leaves the window at 60 s.
  assert.equal(throttle.retryAfter('a'), 30);
  assert.equal(throttle.retryAfter('b'), 0, 'keys are independent');
  now = 60_001;
  assert.equal(throttle.retryAfter('a'), 0);
  throttle.fail('a');
  assert.equal(throttle.retryAfter('a'), 10, 'failures at 10, 20 and 60 s');
  throttle.succeed('a');
  assert.equal(throttle.retryAfter('a'), 0, 'a successful sign-in clears the key');
});
