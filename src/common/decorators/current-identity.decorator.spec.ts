import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import type { VerifiedIdentity } from '../auth/authenticated-request';
import { currentIdentityFactory } from './current-identity.decorator';

// The decorator itself is a thin createParamDecorator wrapper; its factory holds the logic.
describe('@CurrentIdentity()', () => {
  it('returns the identity attached to the request by the guard', () => {
    const identity: VerifiedIdentity = { uid: 'uid-1', email: 'a@example.com', name: 'A' };
    const context = new ExecutionContextHost([{ identity }, {}]);

    expect(currentIdentityFactory(undefined, context)).toBe(identity);
  });
});
