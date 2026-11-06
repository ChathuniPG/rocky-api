import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MAX_CAPTION_LENGTH } from '../posts.constants';
import { CreatePostDto } from './create-post.dto';

const PATH = 'posts/6f1c1b1e-8d5a-4a4e-9a51-2b3c4d5e6f70/0b6f6a52-1c1e-4c43-9a2f-1d1b2f3c4d5e.png';

/** Runs the same transform + validation as the global ValidationPipe. */
function parse(body: Record<string, unknown>): { dto: CreatePostDto; errors: string[] } {
  const dto = plainToInstance(CreatePostDto, body);
  const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).flatMap(
    (error) => Object.values(error.constraints ?? {}),
  );
  return { dto, errors };
}

describe('CreatePostDto', () => {
  it('defaults a missing caption to an empty string', () => {
    const { dto, errors } = parse({ mediaPath: PATH });

    expect(errors).toEqual([]);
    expect(dto.caption).toBe('');
  });

  it('trims the caption', () => {
    expect(parse({ mediaPath: PATH, caption: '  hi  ' }).dto.caption).toBe('hi');
  });

  it('accepts exactly 2200 characters, measured after trimming', () => {
    const caption = ` ${'a'.repeat(MAX_CAPTION_LENGTH)} `;

    expect(parse({ mediaPath: PATH, caption }).errors).toEqual([]);
  });

  it.each([
    ['a caption over 2200 characters', { mediaPath: PATH, caption: 'a'.repeat(2201) }],
    ['a null caption', { mediaPath: PATH, caption: null }],
    ['a numeric caption', { mediaPath: PATH, caption: 5 }],
    ['a missing mediaPath', { caption: 'hi' }],
    ['a non-string mediaPath', { mediaPath: 42 }],
    ['client-supplied media fields', { mediaPath: PATH, mediaUrl: 'https://evil.example' }],
  ])('rejects %s', (_name, body) => {
    expect(parse(body).errors).not.toEqual([]);
  });
});
