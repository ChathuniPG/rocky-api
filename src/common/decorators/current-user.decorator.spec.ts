import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import type { User } from '../../generated/prisma/client';
import { currentUserFactory } from './current-user.decorator';

const user: User = {
  id: '6f1c1b1e-8d5a-4a4e-9a51-2b3c4d5e6f70',
  firebaseUid: 'firebase-uid-123',
  email: 'alice@example.com',
  username: 'alice',
  displayName: 'Alice',
  bio: null,
  avatarUrl: null,
  notificationsEnabled: true,
  language: 'en',
  createdAt: new Date('2026-11-01T10:00:00Z'),
  updatedAt: new Date('2026-11-01T10:00:00Z'),
};

// The decorator itself is a thin createParamDecorator wrapper; its factory holds the logic.
describe('@CurrentUser()', () => {
  it('returns the user attached to the request by the guard', () => {
    const context = new ExecutionContextHost([{ user }, {}]);

    expect(currentUserFactory(undefined, context)).toBe(user);
  });
});
