import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { escapeLikePattern } from '../../src/common/utils/like-pattern';
import { FirebaseAuthService } from '../../src/firebase/firebase-auth.service';
import { FirebaseStorageService } from '../../src/firebase/firebase-storage.service';
import { UserNotFoundError } from '../../src/firebase/firebase.errors';
import type { User } from '../../src/generated/prisma/client';
import { AuthService } from '../../src/modules/auth/auth.service';
import { SignupDto } from '../../src/modules/auth/dto/signup.dto';
import { ConversationsService } from '../../src/modules/messages/conversations.service';
import { CreateMessageDto } from '../../src/modules/messages/dto/create-message.dto';
import { MessagesService } from '../../src/modules/messages/messages.service';
import { CommentsService } from '../../src/modules/posts/comments.service';
import { CreateCommentDto } from '../../src/modules/posts/dto/create-comment.dto';
import { CreatePostDto } from '../../src/modules/posts/dto/create-post.dto';
import { PostEngagementService } from '../../src/modules/posts/post-engagement.service';
import { PostsService } from '../../src/modules/posts/posts.service';
import { UploadsService } from '../../src/modules/uploads/uploads.service';
import { UpdateProfileDto } from '../../src/modules/users/dto/update-profile.dto';
import { FollowsService } from '../../src/modules/users/follows.service';
import { UsersService } from '../../src/modules/users/users.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { renderDemoImage } from './png';
import {
  DEMO_COMMENTS,
  DEMO_CONVERSATIONS,
  DEMO_FOLLOWS,
  DEMO_LIKES,
  DEMO_POSTS,
  DEMO_SAVES,
  DEMO_USERS,
  type DemoUserKey,
  type DemoUserSpec,
} from './seed-data';
import {
  classifyDemoUser,
  DEMO_USERNAME_PREFIX,
  type DemoFirebaseAccount,
  missingByKey,
  planReset,
  SeedRefusedError,
} from './seed-plan';

/** Row counts of the demo data, printed at the end of a run. */
export interface DemoDataTotals {
  users: number;
  posts: number;
  comments: number;
  likes: number;
  saves: number;
  follows: number;
  conversations: number;
  messages: number;
  notifications: number;
}

/**
 * Creates the demo data through the application's own services, so counters (ADR-006),
 * notifications (FR-NOTF-01), storage paths (ADR-007) and validation come from the same
 * code paths as real requests. Every input is validated with the same DTO class and
 * options as the global ValidationPipe. Every step is idempotent: it first reads what
 * exists and only creates what is missing, or calls a service that is idempotent itself.
 */
export class DemoSeeder {
  private readonly logger = new Logger(DemoSeeder.name);
  private readonly prisma: PrismaService;
  private readonly firebaseAuth: FirebaseAuthService;
  private readonly storage: FirebaseStorageService;
  private readonly auth: AuthService;
  private readonly uploads: UploadsService;
  private readonly users: UsersService;
  private readonly follows: FollowsService;
  private readonly posts: PostsService;
  private readonly engagement: PostEngagementService;
  private readonly comments: CommentsService;
  private readonly conversations: ConversationsService;
  private readonly messages: MessagesService;

  /**
   * @param app - A started application context of AppModule. The feature modules do not
   *   export their services; `get` looks them up across all modules.
   * @param password - The shared demo password (SEED_DEMO_PASSWORD). Never logged.
   */
  constructor(
    app: INestApplicationContext,
    private readonly password: string,
  ) {
    this.prisma = app.get(PrismaService);
    this.firebaseAuth = app.get(FirebaseAuthService);
    this.storage = app.get(FirebaseStorageService);
    this.auth = app.get(AuthService);
    this.uploads = app.get(UploadsService);
    this.users = app.get(UsersService);
    this.follows = app.get(FollowsService);
    this.posts = app.get(PostsService);
    this.engagement = app.get(PostEngagementService);
    this.comments = app.get(CommentsService);
    this.conversations = app.get(ConversationsService);
    this.messages = app.get(MessagesService);
  }

  /**
   * Validates every sign-up input before anything is changed, so a password that breaks
   * the sign-up rules stops the run up front instead of after a reset.
   *
   * @throws {SeedRefusedError} If SEED_DEMO_PASSWORD or the demo profiles are invalid.
   */
  async preflight(): Promise<void> {
    for (const spec of DEMO_USERS) {
      const errors = await validationErrors(SignupDto, this.signupInput(spec));
      if (errors.includes('password')) {
        throw new SeedRefusedError(
          'SEED_DEMO_PASSWORD does not meet the sign-up rules: at least 8 characters, ' +
            'with at least one letter and one digit',
        );
      }
      if (errors.length > 0) {
        throw new SeedRefusedError(`Demo user ${spec.username} is invalid: ${errors.join(', ')}`);
      }
    }
  }

  /**
   * Deletes every demo user completely: their Storage folders, Firebase accounts and
   * users rows (which cascade to everything they own). Their likes and comments on other
   * users' posts are removed through the services first, because a cascade would delete
   * those rows without decrementing the posts' counters (ADR-006).
   *
   * @returns The number of demo users whose rows were deleted.
   * @throws {FirebaseUnavailableError} If Firebase fails; rerunning continues the reset.
   */
  async reset(): Promise<number> {
    const rows = await this.prisma.user.findMany({
      // `_` is a LIKE wildcard; planReset re-checks the prefix in code as well.
      where: { username: { startsWith: escapeLikePattern(DEMO_USERNAME_PREFIX) } },
      select: { id: true, firebaseUid: true, username: true },
    });
    const accounts: DemoFirebaseAccount[] = [];
    for (const { email } of DEMO_USERS) {
      const account = await this.firebaseAuth.findUserByEmail(email);
      if (account) {
        accounts.push({ email, uid: account.uid });
      }
    }
    const plan = planReset(rows, accounts, new Set(DEMO_USERS.map((user) => user.email)));

    await this.removeEngagementOnOtherPosts(plan.userIds);
    for (const prefix of plan.storagePrefixes) {
      await this.storage.deleteObjectsWithPrefix(prefix);
    }
    for (const uid of plan.firebaseUids) {
      await this.deleteFirebaseUserIfPresent(uid);
    }
    const { count } = await this.prisma.user.deleteMany({ where: { id: { in: plan.userIds } } });
    this.logger.log(
      `Reset: deleted ${count} demo users, ${plan.firebaseUids.length} Firebase accounts ` +
        `and ${plan.storagePrefixes.length} Storage folders`,
    );
    return count;
  }

  /**
   * Creates everything that is missing, in dependency order.
   *
   * @throws {SeedRefusedError} If a planned input fails DTO validation.
   * @throws {HttpException | FirebaseDomainError} If a service rejects a step.
   */
  async seed(): Promise<void> {
    const userIds = await this.seedUsers();
    const postIds = await this.seedPosts(userIds);
    await this.seedLikesAndSaves(userIds, postIds);
    await this.seedFollows(userIds);
    await this.seedComments(userIds, postIds);
    await this.seedConversations(userIds);
  }

  /**
   * Counts the demo data: rows owned by demo users, and rows on their posts.
   *
   * @returns The totals.
   */
  async totals(): Promise<DemoDataTotals> {
    const ids = (
      await this.prisma.user.findMany({
        where: { username: { in: DEMO_USERS.map((user) => user.username) } },
        select: { id: true },
      })
    ).map((user) => user.id);
    const mine = { in: ids };
    const onDemoPosts = { post: { authorId: mine } };
    return {
      users: ids.length,
      posts: await this.prisma.post.count({ where: { authorId: mine } }),
      comments: await this.prisma.comment.count({ where: onDemoPosts }),
      likes: await this.prisma.like.count({ where: onDemoPosts }),
      saves: await this.prisma.save.count({ where: { userId: mine } }),
      follows: await this.prisma.follow.count({ where: { followerId: mine } }),
      conversations: await this.prisma.conversation.count({
        where: { OR: [{ userAId: mine }, { userBId: mine }] },
      }),
      messages: await this.prisma.message.count({ where: { senderId: mine } }),
      notifications: await this.prisma.notification.count({ where: { recipientId: mine } }),
    };
  }

  /** Signs up missing users and gives each a bio and avatar. Returns IDs by user key. */
  private async seedUsers(): Promise<Map<DemoUserKey, string>> {
    const ids = new Map<DemoUserKey, string>();
    for (const spec of DEMO_USERS) {
      const user = await this.ensureUser(spec);
      await this.ensureProfile(user, spec);
      ids.set(spec.key, user.id);
    }
    return ids;
  }

  private async ensureUser(spec: DemoUserSpec): Promise<User> {
    const row = await this.prisma.user.findUnique({ where: { username: spec.username } });
    const account = await this.firebaseAuth.findUserByEmail(spec.email);
    const action = classifyDemoUser(row, account?.uid ?? null);
    if (action.kind === 'keep' && row) {
      return row;
    }
    if (action.kind === 'create') {
      // Leftovers of an interrupted run: sign-up would fail on the email or username.
      if (action.deleteUserId !== undefined || action.deleteFirebaseUid !== undefined) {
        this.logger.warn(`Removing incomplete leftovers of ${spec.username} before sign-up`);
      }
      if (action.deleteUserId !== undefined) {
        await this.removeEngagementOnOtherPosts([action.deleteUserId]);
        await this.storage.deleteObjectsWithPrefix(`posts/${action.deleteUserId}/`);
        await this.storage.deleteObjectsWithPrefix(`avatars/${action.deleteUserId}/`);
        await this.prisma.user.delete({ where: { id: action.deleteUserId } });
      }
      if (action.deleteFirebaseUid !== undefined) {
        await this.deleteFirebaseUserIfPresent(action.deleteFirebaseUid);
      }
    }
    // The session tokens in the result are discarded unread.
    const { user } = await this.auth.signup(await validDto(SignupDto, this.signupInput(spec)));
    this.logger.log(`Signed up ${spec.username}`);
    return this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  }

  private async ensureProfile(user: User, spec: DemoUserSpec): Promise<void> {
    const needsAvatar = user.avatarPath === null;
    if (!needsAvatar && user.bio === spec.bio) {
      return;
    }
    const avatarPath = needsAvatar
      ? (await this.uploads.upload(user.id, 'avatar', { buffer: renderDemoImage(spec.avatar) }))
          .path
      : undefined;
    const dto = await validDto(UpdateProfileDto, {
      bio: spec.bio,
      ...(avatarPath === undefined ? {} : { avatarPath }),
    });
    await this.users.updateProfile(user, dto);
  }

  /** Uploads and creates the missing posts, oldest first. Returns post IDs by caption. */
  private async seedPosts(userIds: Map<DemoUserKey, string>): Promise<Map<string, string>> {
    const existing = await this.prisma.post.findMany({
      where: { authorId: { in: [...userIds.values()] } },
      select: { id: true, authorId: true, caption: true },
    });
    const postIds = new Map(existing.map((post) => [post.caption, post.id]));
    const missing = missingByKey(
      DEMO_POSTS,
      new Set(existing.map((post) => postKey(post.authorId, post.caption))),
      (post) => postKey(idOf(userIds, post.author), post.caption),
    );

    for (const post of missing) {
      const authorId = idOf(userIds, post.author);
      // Two-step upload (ADR-007), exactly like the web client.
      const upload = await this.uploads.upload(authorId, 'post', {
        buffer: renderDemoImage(post.image),
      });
      const dto = await validDto(CreatePostDto, { caption: post.caption, mediaPath: upload.path });
      const created = await this.posts.create(authorId, dto);
      postIds.set(post.caption, created.id);
    }
    this.logger.log(`Posts: ${missing.length} created, ${DEMO_POSTS.length - missing.length} kept`);
    return postIds;
  }

  /** Like and save are idempotent in the service: a repeat changes no counter. */
  private async seedLikesAndSaves(
    userIds: Map<DemoUserKey, string>,
    postIds: Map<string, string>,
  ): Promise<void> {
    for (const like of DEMO_LIKES) {
      await this.engagement.like(idOf(userIds, like.user), idOf(postIds, like.postCaption));
    }
    for (const save of DEMO_SAVES) {
      await this.engagement.save(idOf(userIds, save.user), idOf(postIds, save.postCaption));
    }
  }

  /** Follow is idempotent in the service: a repeat creates no notification. */
  private async seedFollows(userIds: Map<DemoUserKey, string>): Promise<void> {
    for (const follow of DEMO_FOLLOWS) {
      await this.follows.follow(idOf(userIds, follow.follower), idOf(userIds, follow.following));
    }
  }

  private async seedComments(
    userIds: Map<DemoUserKey, string>,
    postIds: Map<string, string>,
  ): Promise<void> {
    const existing = await this.prisma.comment.findMany({
      where: { postId: { in: [...postIds.values()] } },
      select: { postId: true, authorId: true, body: true },
    });
    const missing = missingByKey(
      DEMO_COMMENTS,
      new Set(existing.map((c) => commentKey(c.postId, c.authorId, c.body))),
      (c) => commentKey(idOf(postIds, c.postCaption), idOf(userIds, c.author), c.body),
    );

    for (const comment of missing) {
      const dto = await validDto(CreateCommentDto, { body: comment.body });
      await this.comments.create(
        idOf(userIds, comment.author),
        idOf(postIds, comment.postCaption),
        dto,
      );
    }
    this.logger.log(
      `Comments: ${missing.length} created, ${DEMO_COMMENTS.length - missing.length} kept`,
    );
  }

  /** Opening a conversation is idempotent; messages are sent only if missing. */
  private async seedConversations(userIds: Map<DemoUserKey, string>): Promise<void> {
    for (const spec of DEMO_CONVERSATIONS) {
      const [starter, recipient] = spec.between;
      const { conversation } = await this.conversations.open(
        idOf(userIds, starter),
        idOf(userIds, recipient),
      );
      const existing = await this.prisma.message.findMany({
        where: { conversationId: conversation.id },
        select: { senderId: true, body: true },
      });
      const missing = missingByKey(
        spec.messages,
        new Set(existing.map((message) => `${message.senderId}|${message.body}`)),
        (message) => `${idOf(userIds, message.from)}|${message.body}`,
      );
      for (const message of missing) {
        const dto = await validDto(CreateMessageDto, { body: message.body });
        await this.messages.send(idOf(userIds, message.from), conversation.id, dto);
      }
      if (spec.readBy !== undefined) {
        await this.messages.markRead(idOf(userIds, spec.readBy), conversation.id);
      }
      this.logger.log(
        `Conversation ${starter}/${recipient}: ${missing.length} messages sent, ` +
          `${spec.messages.length - missing.length} kept`,
      );
    }
  }

  /**
   * Unlikes and deletes the comments of the given users on posts by anyone else, through
   * the services, so those posts' like and comment counts stay correct. Rows on the
   * users' own posts need nothing: the posts themselves are deleted.
   */
  private async removeEngagementOnOtherPosts(userIds: readonly string[]): Promise<void> {
    if (userIds.length === 0) {
      return;
    }
    const otherPost = { post: { authorId: { notIn: [...userIds] } } };
    const likes = await this.prisma.like.findMany({
      where: { userId: { in: [...userIds] }, ...otherPost },
      select: { userId: true, postId: true },
    });
    for (const like of likes) {
      await this.engagement.unlike(like.userId, like.postId);
    }
    const comments = await this.prisma.comment.findMany({
      where: { authorId: { in: [...userIds] }, ...otherPost },
      select: { id: true, authorId: true },
    });
    for (const comment of comments) {
      await this.comments.delete(comment.authorId, comment.id);
    }
  }

  private async deleteFirebaseUserIfPresent(uid: string): Promise<void> {
    try {
      await this.firebaseAuth.deleteUser(uid);
    } catch (error: unknown) {
      // Already gone, e.g. deleted by an earlier, interrupted reset.
      if (!(error instanceof UserNotFoundError)) {
        throw error;
      }
    }
  }

  private signupInput(spec: DemoUserSpec): Record<string, unknown> {
    return {
      email: spec.email,
      password: this.password,
      username: spec.username,
      displayName: spec.displayName,
    };
  }
}

/** Idempotency key of a post: captions are unique per author in the seed content. */
function postKey(authorId: string, caption: string): string {
  return `${authorId}|${caption}`;
}

/** Idempotency key of a comment. */
function commentKey(postId: string, authorId: string, body: string): string {
  return `${postId}|${authorId}|${body}`;
}

/** Looks up an ID the seed itself recorded; a miss is a bug in the seed content. */
function idOf<K>(ids: ReadonlyMap<K, string>, key: K): string {
  const id = ids.get(key);
  if (id === undefined) {
    throw new Error(`Seed content refers to an unknown item: ${String(key)}`);
  }
  return id;
}

/**
 * Validates and transforms input exactly like the global ValidationPipe
 * (`whitelist`, `forbidNonWhitelisted`, `transform`), so seeded data passes the same
 * rules as data from the web client.
 *
 * @throws {SeedRefusedError} Naming the failing properties, never their values (one of
 *   them may be the password).
 */
async function validDto<T extends object>(
  dtoClass: new () => T,
  plain: Record<string, unknown>,
): Promise<T> {
  const dto = plainToInstance(dtoClass, plain);
  const failing = await validationErrorsOf(dto);
  if (failing.length > 0) {
    throw new SeedRefusedError(`Invalid ${dtoClass.name}: ${failing.join(', ')}`);
  }
  return dto;
}

async function validationErrors(
  dtoClass: new () => object,
  plain: Record<string, unknown>,
): Promise<string[]> {
  return validationErrorsOf(plainToInstance(dtoClass, plain));
}

async function validationErrorsOf(dto: object): Promise<string[]> {
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((error) => error.property);
}
