import { ApiProperty } from '@nestjs/swagger';
import { MediaType } from '../../../generated/prisma/enums';
import type { MediaContentType } from '../media-signature';

/** Response of POST /uploads (design §5.2): where the file is and what it is. */
export class UploadResponseDto {
  @ApiProperty({
    format: 'uri',
    description: 'Long-lived Firebase download URL, for displaying the media.',
    example:
      'https://firebasestorage.googleapis.com/v0/b/rocky.firebasestorage.app/o/posts%2F...?alt=media&token=...',
  })
  url: string;

  @ApiProperty({
    description: 'Storage path, sent back when creating the post (ADR-007).',
    example: 'posts/6f1c1b1e-8d5a-4a4e-9a51-2b3c4d5e6f70/0b6f6a52-1c1e-4c43-9a2f-1d1b2f3c4d5e.png',
  })
  path: string;

  @ApiProperty({ enum: MediaType, enumName: 'MediaType', example: MediaType.IMAGE })
  mediaType: MediaType;

  @ApiProperty({
    enum: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'],
    description: 'Detected from the file contents, not from the name or declared type.',
    example: 'image/png',
  })
  contentType: MediaContentType;

  @ApiProperty({ example: 48213 })
  sizeBytes: number;
}
