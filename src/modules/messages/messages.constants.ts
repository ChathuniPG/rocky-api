import { HttpStatus } from '@nestjs/common';

/** Errors every conversation and message endpoint can return (Swagger documentation). */
export const CONVERSATION_COMMON_ERRORS = [
  HttpStatus.UNAUTHORIZED,
  HttpStatus.FORBIDDEN,
  HttpStatus.TOO_MANY_REQUESTS,
  HttpStatus.SERVICE_UNAVAILABLE,
] as const;

/** Matches messages.body varchar(1000) (FR-MSG-03). */
export const MAX_MESSAGE_LENGTH = 1000;

// Client-facing error messages, exported for tests.

export const CANNOT_MESSAGE_SELF = 'You cannot start a conversation with yourself';

/**
 * Also returned for a conversation the user does not take part in, so its existence is
 * not revealed (NFR-SEC-02).
 */
export const CONVERSATION_NOT_FOUND = 'Conversation not found';

export const CURSOR_WITH_AFTER = 'Use either cursor (history) or after (polling), not both';

export const INVALID_AFTER = 'after must be the ID of a message in this conversation';
