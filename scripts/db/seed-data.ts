import type { DemoImageSpec, DemoShape, Rgb } from './png';
import { DEMO_EMAIL_DOMAIN, DEMO_USERNAME_PREFIX } from './seed-plan';

/**
 * The demo content: who the demo users are and what they post, like, save, follow,
 * comment and message. Everything is deterministic, so every run plans the same rows and
 * the seed can tell what already exists. Captions, comment bodies and message bodies are
 * unique within their scope because they are the idempotency keys.
 */

/** Post images: portrait, like a phone screen, small enough to upload quickly. */
const POST_SIZE = { width: 540, height: 960 } as const;
const AVATAR_SIZE = { width: 256, height: 256 } as const;

/** One demo user. `key` is the username without the prefix. */
export interface DemoUserSpec {
  key: DemoUserKey;
  username: string;
  email: string;
  displayName: string;
  bio: string;
  avatar: DemoImageSpec;
}

/** One demo post. The caption identifies it on later runs. */
export interface DemoPostSpec {
  author: DemoUserKey;
  caption: string;
  image: DemoImageSpec;
}

/** One like or save. */
export interface DemoEngagementSpec {
  user: DemoUserKey;
  postCaption: string;
}

/** One follow. */
export interface DemoFollowSpec {
  follower: DemoUserKey;
  following: DemoUserKey;
}

/** One comment. The body identifies it, together with post and author. */
export interface DemoCommentSpec {
  author: DemoUserKey;
  postCaption: string;
  body: string;
}

/** One conversation and its messages, in sending order. */
export interface DemoConversationSpec {
  between: readonly [DemoUserKey, DemoUserKey];
  messages: readonly { from: DemoUserKey; body: string }[];
  /** Participant who has read the other's messages; otherwise they stay unread. */
  readBy?: DemoUserKey;
}

const USER_KEYS = ['maya', 'leo', 'aiko', 'sam', 'noor', 'ravi'] as const;
export type DemoUserKey = (typeof USER_KEYS)[number];

/** Two gradient colours and an accent per user, so each profile grid has its own look. */
const PALETTES: Readonly<Record<DemoUserKey, { from: Rgb; to: Rgb; accent: Rgb }>> = {
  maya: { from: rgb(0xff6b6b), to: rgb(0x5f27cd), accent: rgb(0xfeca57) },
  leo: { from: rgb(0x48dbfb), to: rgb(0x0a3d62), accent: rgb(0xffffff) },
  aiko: { from: rgb(0xff9ff3), to: rgb(0xf368e0), accent: rgb(0x341f97) },
  sam: { from: rgb(0x1dd1a1), to: rgb(0x10ac84), accent: rgb(0x222f3e) },
  noor: { from: rgb(0xfeca57), to: rgb(0xff6348), accent: rgb(0xffffff) },
  ravi: { from: rgb(0x576574), to: rgb(0x222f3e), accent: rgb(0x00d2d3) },
};

const PROFILES: Readonly<Record<DemoUserKey, { displayName: string; bio: string }>> = {
  maya: { displayName: 'Maya Fernando', bio: 'Street food, sunsets and slow travel. 🌅' },
  leo: { displayName: 'Leo Martins', bio: 'Surfing before work, coding after. 🏄' },
  aiko: { displayName: 'Aiko Tanaka', bio: 'Illustrator. Drawing one tiny thing every day.' },
  sam: { displayName: 'Sam Okafor', bio: 'Plants, bikes and too much coffee. ☕' },
  noor: { displayName: 'Noor Haddad', bio: 'Home baker. Ask me about sourdough. 🍞' },
  ravi: { displayName: 'Ravi Perera', bio: 'Night photography and synth music. 🎹' },
};

/** The six demo users. */
export const DEMO_USERS: readonly DemoUserSpec[] = USER_KEYS.map((key, index) => ({
  key,
  username: `${DEMO_USERNAME_PREFIX}${key}`,
  email: `demo.${key}@${DEMO_EMAIL_DOMAIN}`,
  ...PROFILES[key],
  avatar: {
    ...AVATAR_SIZE,
    from: PALETTES[key].from,
    to: PALETTES[key].to,
    shapes: [
      {
        kind: 'circle',
        cx: 0.5,
        cy: 0.42,
        radius: 0.22,
        color: PALETTES[key].accent,
        opacity: 0.9,
      },
      {
        kind: 'circle',
        cx: 0.5,
        cy: 1.05,
        radius: 0.42,
        color: PALETTES[key].accent,
        opacity: 0.9,
      },
      ...shapesFor(1000 + index, PALETTES[key].accent).slice(0, 1),
    ],
  },
}));

/** Captions per author; posts are created round-robin so the feed mixes authors. */
const CAPTIONS: Readonly<Record<DemoUserKey, readonly string[]>> = {
  maya: [
    'Golden hour from the rooftop 🌇',
    'Kottu at midnight is a whole mood',
    'Packed my bag in 10 minutes. New record.',
    'Rain in the hills, tea in hand ☔',
    'Market colours this morning 🍋',
  ],
  leo: [
    'Glassy waves at 6am 🌊',
    'Shipped the feature, now the beach',
    'Board wax smell = happiness',
    'Tide charts are my calendar',
  ],
  aiko: [
    'Day 112: a cat on a cloud ☁️',
    'Trying a new palette, thoughts?',
    'Sketchbook tour, part 1 ✏️',
    'Ink spills are happy accidents',
  ],
  sam: [
    'New leaf on the monstera 🌿',
    '40 km loop before breakfast 🚲',
    'Cold brew experiment #3',
    'Repotting day. Send help.',
  ],
  noor: [
    'Sourdough ear finally achieved 🍞',
    'Cardamom buns for the neighbours',
    'Starter is 2 years old today 🎉',
    'Flour everywhere, no regrets',
  ],
  ravi: [
    'Long exposure, city lights 🌃',
    'Late night jam on the new synth 🎹',
    'Neon after the rain',
    'Fog, streetlights and silence',
  ],
};

/**
 * The post with more than one page of comments. Created last, so it opens the feed.
 * Not in CAPTIONS, so it appears exactly once.
 */
export const POPULAR_POST_CAPTION = 'Who else is up for a sunrise hike this weekend? 🏔️';

/** About 25 posts, round-robin across the authors, the popular one last. */
export const DEMO_POSTS: readonly DemoPostSpec[] = [
  ...roundRobin(CAPTIONS).map(({ author, caption }, index) => ({
    author,
    caption,
    image: postImage(author, index),
  })),
  { author: 'maya', caption: POPULAR_POST_CAPTION, image: postImage('maya', 99) },
];

/**
 * Likes: on every post, a deterministic subset of the other users, so like counts vary
 * from 1 to 5 across the feed.
 */
export const DEMO_LIKES: readonly DemoEngagementSpec[] = DEMO_POSTS.flatMap((post, index) =>
  USER_KEYS.filter(
    (user, userIndex) => user !== post.author && (index + userIndex) % (2 + (index % 3)) !== 0,
  ).map((user) => ({ user, postCaption: post.caption })),
);

/** Saves: every third post, by the next user in the list who is not the author. */
export const DEMO_SAVES: readonly DemoEngagementSpec[] = DEMO_POSTS.filter(
  (_post, index) => index % 3 === 0,
).flatMap((post, index) =>
  USER_KEYS.filter((user) => user !== post.author)
    .slice(index % 4, (index % 4) + 2)
    .map((user) => ({ user, postCaption: post.caption })),
);

/** Follows: a ring (each user follows the next) plus some extra pairs. */
export const DEMO_FOLLOWS: readonly DemoFollowSpec[] = [
  ...USER_KEYS.map((follower, index) => ({
    follower,
    following: USER_KEYS[(index + 1) % USER_KEYS.length],
  })),
  { follower: 'leo', following: 'maya' },
  { follower: 'aiko', following: 'maya' },
  { follower: 'sam', following: 'maya' },
  { follower: 'noor', following: 'aiko' },
  { follower: 'ravi', following: 'leo' },
  { follower: 'maya', following: 'ravi' },
  { follower: 'sam', following: 'leo' },
  { follower: 'aiko', following: 'ravi' },
];

const POPULAR_COMMENTS: readonly [DemoUserKey, string][] = [
  ['leo', "I'm in! What time are we starting?"],
  ['maya', 'Thinking 4:30am at the trailhead 🔦'],
  ['aiko', "4:30?! Ok fine, I'll bring the sketchbook"],
  ['sam', 'Count me in, I can drive two people'],
  ['noor', "I'll bake something for the summit 🥐"],
  ['ravi', 'Bringing the tripod for the sunrise shots'],
  ['leo', 'Noor, please make the cardamom buns'],
  ['noor', 'Cardamom buns it is 😄'],
  ['maya', 'Remember warm layers, it is cold up there'],
  ['sam', 'Is the trail muddy after the rain?'],
  ['ravi', 'It was fine last month, a bit slippery near the top'],
  ['aiko', 'Good shoes then. Noted 👟'],
  ['leo', 'Can we stop for kottu on the way back?'],
  ['maya', 'Obviously. That is the real reason we hike'],
  ['sam', 'I have two spare head torches if anyone needs one'],
  ['noor', 'Me please! Mine broke'],
  ['ravi', 'Weather looks clear for Saturday ☀️'],
  ['aiko', 'Perfect light for painting then'],
  ['leo', 'Making a playlist for the drive 🎶'],
  ['ravi', 'Add some synthwave please'],
  ['maya', 'Meeting point: the bakery corner at 4:15'],
  ['sam', 'See you all there! 🙌'],
];

/**
 * Comments: 22 on the popular post (more than one page of 15), plus one or two on a few
 * other posts.
 */
export const DEMO_COMMENTS: readonly DemoCommentSpec[] = [
  ...POPULAR_COMMENTS.map(([author, body]) => ({
    author,
    postCaption: POPULAR_POST_CAPTION,
    body,
  })),
  { author: 'leo', postCaption: 'Golden hour from the rooftop 🌇', body: 'That sky is unreal' },
  { author: 'aiko', postCaption: 'Golden hour from the rooftop 🌇', body: 'Painting this tonight' },
  { author: 'noor', postCaption: 'Glassy waves at 6am 🌊', body: 'Jealous of that water!' },
  { author: 'maya', postCaption: 'Day 112: a cat on a cloud ☁️', body: 'This made my day 😻' },
  { author: 'sam', postCaption: 'Sourdough ear finally achieved 🍞', body: 'Look at that crumb!' },
  { author: 'ravi', postCaption: 'New leaf on the monstera 🌿', body: 'Plant parent goals' },
  {
    author: 'leo',
    postCaption: 'Long exposure, city lights 🌃',
    body: 'How long was the exposure?',
  },
  { author: 'ravi', postCaption: 'Long exposure, city lights 🌃', body: 'About 20 seconds' },
];

/** Two conversations; the first has been read, the second has unread messages. */
export const DEMO_CONVERSATIONS: readonly DemoConversationSpec[] = [
  {
    between: ['maya', 'leo'],
    readBy: 'leo',
    messages: [
      { from: 'maya', body: 'Hey! Are you joining the sunrise hike?' },
      { from: 'leo', body: 'Definitely. Can I bring my board in your car? 😅' },
      { from: 'maya', body: 'To a mountain? Leo.' },
      { from: 'leo', body: 'Fair point. Just snacks then.' },
      { from: 'maya', body: 'Perfect. Pick you up at 4?' },
      { from: 'leo', body: 'See you at 4 🙌' },
    ],
  },
  {
    between: ['aiko', 'sam'],
    messages: [
      { from: 'aiko', body: 'Your monstera post inspired my next drawing 🌿' },
      { from: 'sam', body: 'No way! Can I see it when it is done?' },
      { from: 'aiko', body: 'Of course. Sending a sketch tonight' },
      { from: 'sam', body: 'Want a cutting? It needs a new home' },
      { from: 'aiko', body: 'Yes please!! I will take good care of it' },
      { from: 'aiko', body: 'Also, are you driving on Saturday?' },
    ],
  },
];

function rgb(hex: number): Rgb {
  return { r: (hex >> 16) & 0xff, g: (hex >> 8) & 0xff, b: hex & 0xff };
}

/** Takes the first caption of each author, then the second, and so on. */
function roundRobin(
  captions: Readonly<Record<DemoUserKey, readonly string[]>>,
): { author: DemoUserKey; caption: string }[] {
  const longest = Math.max(...USER_KEYS.map((key) => captions[key].length));
  const result: { author: DemoUserKey; caption: string }[] = [];
  for (let round = 0; round < longest; round++) {
    for (const author of USER_KEYS) {
      const caption = captions[author][round];
      if (caption !== undefined) {
        result.push({ author, caption });
      }
    }
  }
  return result;
}

function postImage(author: DemoUserKey, seed: number): DemoImageSpec {
  const palette = PALETTES[author];
  return {
    ...POST_SIZE,
    from: palette.from,
    to: palette.to,
    shapes: shapesFor(seed, palette.accent),
  };
}

/** Three to five shapes with positions from a seeded generator: varied but repeatable. */
function shapesFor(seed: number, accent: Rgb): DemoShape[] {
  const random = mulberry32(seed + 1);
  const count = 3 + Math.floor(random() * 3);
  return Array.from({ length: count }, (): DemoShape => {
    const opacity = 0.25 + random() * 0.5;
    const pick = random();
    if (pick < 0.4) {
      return {
        kind: 'circle',
        cx: random(),
        cy: random(),
        radius: 0.08 + random() * 0.25,
        color: accent,
        opacity,
      };
    }
    if (pick < 0.75) {
      return {
        kind: 'ring',
        cx: random(),
        cy: random(),
        radius: 0.15 + random() * 0.3,
        thickness: 0.02 + random() * 0.05,
        color: accent,
        opacity,
      };
    }
    return {
      kind: 'bar',
      x: random() * 0.7,
      y: random(),
      width: 0.2 + random() * 0.5,
      height: 0.03 + random() * 0.06,
      color: accent,
      opacity,
    };
  });
}

/** A tiny seeded PRNG (Mulberry32): deterministic, unlike Math.random. Not for security. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
