import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { buildUser } from '../../../test/fixtures/user.fixture';
import { currentUserFactory } from './current-user.decorator';

// The decorator itself is a thin createParamDecorator wrapper; its factory holds the logic.
describe('@CurrentUser()', () => {
  it('returns the user attached to the request by the guard', () => {
    const user = buildUser();
    const context = new ExecutionContextHost([{ user }, {}]);

    expect(currentUserFactory(undefined, context)).toBe(user);
  });
});
