import { DEFAULT_PAGE_SIZE } from '../../src/common/pagination/pagination-query.dto';
import {
  DEMO_COMMENTS,
  DEMO_CONVERSATIONS,
  DEMO_FOLLOWS,
  DEMO_LIKES,
  DEMO_POSTS,
  DEMO_SAVES,
  DEMO_USERS,
  POPULAR_POST_CAPTION,
} from './seed-data';
import { SeedEnv } from '../../src/config/env.validation';
import { demoEmail, isDemoUsername } from './seed-plan';

// The seed relies on these properties for idempotency and for a demo that shows every
// feature; a careless edit of the content should fail here, not during a live run.
describe('demo seed content', () => {
  const captions = new Set(DEMO_POSTS.map((post) => post.caption));
  const userKeys = new Set(DEMO_USERS.map((user) => user.key));

  it('has six users with demo usernames and distinct names', () => {
    expect(DEMO_USERS).toHaveLength(6);
    expect(DEMO_USERS.every((user) => isDemoUsername(user.username))).toBe(true);
    expect(new Set(DEMO_USERS.map((user) => user.displayName)).size).toBe(6);
    expect(new Set(DEMO_USERS.map((user) => user.bio)).size).toBe(6);
  });

  it.each(Object.values(SeedEnv))('gives every user a distinct %s email', (seedEnv) => {
    const emails = DEMO_USERS.map((user) => demoEmail(user.key, seedEnv));

    expect(new Set(emails).size).toBe(DEMO_USERS.length);
    expect(emails.every((email) => email.endsWith(`+${seedEnv}@example.com`))).toBe(true);
  });

  it('never gives two environments the same demo email', () => {
    const local = DEMO_USERS.map((user) => demoEmail(user.key, SeedEnv.Local));
    const production = DEMO_USERS.map((user) => demoEmail(user.key, SeedEnv.Production));

    expect(local.filter((email) => production.includes(email))).toEqual([]);
  });

  it('has unique captions and more posts than one feed page', () => {
    expect(captions.size).toBe(DEMO_POSTS.length);
    expect(DEMO_POSTS.length).toBeGreaterThan(DEFAULT_PAGE_SIZE);
    expect(DEMO_POSTS.length).toBeGreaterThanOrEqual(25);
  });

  it('gives one post at least 20 comments, more than one comment page', () => {
    const popular = DEMO_COMMENTS.filter((comment) => comment.postCaption === POPULAR_POST_CAPTION);

    expect(popular.length).toBeGreaterThanOrEqual(20);
    expect(popular.length).toBeGreaterThan(DEFAULT_PAGE_SIZE);
  });

  it('only refers to posts and users that exist', () => {
    for (const item of [...DEMO_LIKES, ...DEMO_SAVES, ...DEMO_COMMENTS]) {
      expect(captions.has(item.postCaption)).toBe(true);
    }
    for (const user of [
      ...DEMO_POSTS.map((post) => post.author),
      ...DEMO_LIKES.map((like) => like.user),
      ...DEMO_SAVES.map((save) => save.user),
      ...DEMO_FOLLOWS.flatMap((follow) => [follow.follower, follow.following]),
      ...DEMO_CONVERSATIONS.flatMap((conversation) => conversation.between),
    ]) {
      expect(userKeys.has(user)).toBe(true);
    }
  });

  it('has unique comment keys, the idempotency key of comments', () => {
    const keys = DEMO_COMMENTS.map((c) => `${c.postCaption}|${c.author}|${c.body}`);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has no self-follows, no duplicate follows and no likes on own posts', () => {
    const follows = DEMO_FOLLOWS.map((follow) => `${follow.follower}>${follow.following}`);

    expect(DEMO_FOLLOWS.every((follow) => follow.follower !== follow.following)).toBe(true);
    expect(new Set(follows).size).toBe(follows.length);
    const authorOf = new Map(DEMO_POSTS.map((post) => [post.caption, post.author]));
    expect(DEMO_LIKES.every((like) => authorOf.get(like.postCaption) !== like.user)).toBe(true);
  });

  it('has two conversations between different users with unique message bodies', () => {
    expect(DEMO_CONVERSATIONS).toHaveLength(2);
    for (const conversation of DEMO_CONVERSATIONS) {
      const [first, second] = conversation.between;
      const bodies = conversation.messages.map((message) => `${message.from}|${message.body}`);

      expect(first).not.toBe(second);
      expect(conversation.messages.length).toBeGreaterThanOrEqual(5);
      expect(new Set(bodies).size).toBe(bodies.length);
      expect(conversation.messages.every((m) => conversation.between.includes(m.from))).toBe(true);
    }
  });
});
