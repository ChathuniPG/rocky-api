import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, Public } from './public.decorator';

// `this: void`: the handlers never use `this`, so they can be passed around unbound.
class Controller {
  @Public()
  publicHandler(this: void): void {}

  privateHandler(this: void): void {}
}

@Public()
class PublicController {}

describe('@Public()', () => {
  const reflector = new Reflector();

  it('marks a handler as public', () => {
    expect(reflector.get<boolean>(IS_PUBLIC_KEY, Controller.prototype.publicHandler)).toBe(true);
  });

  it('leaves other handlers unmarked', () => {
    expect(
      reflector.get<boolean | undefined>(IS_PUBLIC_KEY, Controller.prototype.privateHandler),
    ).toBeUndefined();
  });

  it('marks a controller class as public', () => {
    expect(reflector.get<boolean>(IS_PUBLIC_KEY, PublicController)).toBe(true);
  });
});
