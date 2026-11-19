import { Reflector } from '@nestjs/core';
import {
  ALLOW_INCOMPLETE_PROFILE_KEY,
  AllowIncompleteProfile,
} from './allow-incomplete-profile.decorator';

// `this: void`: the handlers never use `this`, so they can be passed around unbound.
class Controller {
  @AllowIncompleteProfile()
  setupHandler(this: void): void {}

  otherHandler(this: void): void {}
}

describe('@AllowIncompleteProfile()', () => {
  const reflector = new Reflector();

  it('marks a handler', () => {
    expect(
      reflector.get<boolean>(ALLOW_INCOMPLETE_PROFILE_KEY, Controller.prototype.setupHandler),
    ).toBe(true);
  });

  it('leaves other handlers unmarked', () => {
    expect(
      reflector.get<boolean | undefined>(
        ALLOW_INCOMPLETE_PROFILE_KEY,
        Controller.prototype.otherHandler,
      ),
    ).toBeUndefined();
  });
});
