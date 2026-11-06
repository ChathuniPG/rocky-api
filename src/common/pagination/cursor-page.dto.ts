import type { Type } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import type { CursorPage } from './cursor-pagination';

/**
 * Builds the Swagger class of a page of `itemType`. TypeScript generics vanish at
 * runtime, so Swagger cannot describe `CursorPage<T>` by itself (the same problem as
 * documenting `Page<T>` with springdoc). Extend the result with a named class, so the
 * OpenAPI document gets one schema per item type:
 *
 *   export class PostPageDto extends CursorPageDto(PostResponseDto) {}
 *
 * @param itemType - The DTO class of one item.
 * @returns An anonymous class with `items` and `nextCursor`.
 */
export function CursorPageDto<T>(itemType: Type<T>): Type<CursorPage<T>> {
  class CursorPageOfItems implements CursorPage<T> {
    @ApiProperty({ type: itemType, isArray: true })
    items: T[];

    @ApiProperty({
      type: String,
      nullable: true,
      description: 'Pass as `cursor` to get the next page; `null` on the last page.',
      example: null,
    })
    nextCursor: string | null;
  }
  return CursorPageOfItems;
}
