import type { TransformFnParams } from 'class-transformer';

// Normalisers for DTO properties, used with class-transformer's @Transform. Non-string
// values are returned unchanged, so @IsString / @IsEmail still reject them with a clear
// message instead of the transform throwing.

/**
 * Trims surrounding whitespace.
 *
 * @example @Transform(trim) displayName: string;
 */
export function trim({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim() : (value as unknown);
}

/**
 * Trims surrounding whitespace and converts to lowercase (emails, usernames).
 *
 * @example @Transform(trimAndLowercase) email: string;
 */
export function trimAndLowercase({ value }: TransformFnParams): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : (value as unknown);
}
