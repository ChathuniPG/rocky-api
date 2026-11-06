import { parseMediaPath } from './media-path';
import { mediaByContentType, MEDIA_FORMATS } from './media-signature';

const OWNER = '6f1c1b1e-8d5a-4a4e-9a51-2b3c4d5e6f70';
const FILE = '0b6f6a52-1c1e-4c43-9a2f-1d1b2f3c4d5e';

describe('parseMediaPath', () => {
  it.each(['jpg', 'png', 'webp', 'mp4', 'webm'] as const)(
    'parses a post path with extension %s',
    (extension) => {
      expect(parseMediaPath(`posts/${OWNER}/${FILE}.${extension}`, 'post')).toEqual({
        ownerId: OWNER,
        extension,
      });
    },
  );

  it('parses an avatar image path and rejects an avatar video path', () => {
    expect(parseMediaPath(`avatars/${OWNER}/${FILE}.png`, 'avatar')).toEqual({
      ownerId: OWNER,
      extension: 'png',
    });
    expect(parseMediaPath(`avatars/${OWNER}/${FILE}.mp4`, 'avatar')).toBeNull();
  });

  it.each([
    ['the wrong folder', `avatars/${OWNER}/${FILE}.png`],
    ['a leading slash', `/posts/${OWNER}/${FILE}.png`],
    ['path traversal', `posts/${OWNER}/../${OWNER}/${FILE}.png`],
    ['an extra segment', `posts/${OWNER}/x/${FILE}.png`],
    ['a non-UUID owner', `posts/alice/${FILE}.png`],
    ['a non-UUID file name', `posts/${OWNER}/picture.png`],
    ['an uppercase UUID', `posts/${OWNER.toUpperCase()}/${FILE}.png`],
    ['a disallowed extension', `posts/${OWNER}/${FILE}.gif`],
    ['an uppercase extension', `posts/${OWNER}/${FILE}.PNG`],
    ['a trailing newline', `posts/${OWNER}/${FILE}.png\n`],
    ['a query string', `posts/${OWNER}/${FILE}.png?x=1`],
    ['an empty string', ''],
  ])('rejects %s', (_name, path) => {
    expect(parseMediaPath(path, 'post')).toBeNull();
  });
});

describe('mediaByContentType', () => {
  it.each(MEDIA_FORMATS.map((format) => [format.contentType, format] as const))(
    'finds %s',
    (contentType, format) => {
      expect(mediaByContentType(contentType)).toBe(format);
    },
  );

  it.each([undefined, '', 'image/gif', 'text/plain', 'IMAGE/PNG'])('rejects %p', (contentType) => {
    expect(mediaByContentType(contentType)).toBeNull();
  });
});
