import {
  Body,
  Controller,
  HttpStatus,
  ParseFilePipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ID_TOKEN_COOKIE } from '../../common/auth/auth-cookies';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ApiErrorResponses } from '../../common/swagger/api-error-responses.decorator';
import { DEFAULT_THROTTLER, UPLOAD_THROTTLE } from '../../common/throttling/throttling.constants';
import type { User } from '../../generated/prisma/client';
import { CreateUploadDto } from './dto/create-upload.dto';
import { UploadResponseDto } from './dto/upload-response.dto';
import type { UploadedMediaFile } from './uploaded-media-file';
import { MULTIPART_LIMITS, UPLOAD_PURPOSES } from './uploads.constants';
import { UploadsService } from './uploads.service';

/** Name of the multipart part that carries the file. */
export const UPLOAD_FILE_FIELD = 'file';

/**
 * POST /uploads (design §5.2, ADR-007). `FileInterceptor` is Nest's wrapper around multer,
 * comparable to Spring's `MultipartFile` support with `spring.servlet.multipart.*` limits.
 * Without a `dest` or `storage` option, multer keeps the file in memory, which is what we
 * want: it is inspected and then streamed to Firebase Storage, never written to local disk.
 */
@ApiTags('Uploads')
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  /** Uploads a post media file or an avatar (FR-POST-02, FR-PROF-04, NFR-SEC-07). */
  @Post()
  // Uploads are expensive (up to 25 MB each, plus Storage writes), so they get a stricter
  // per-IP limit than the global default (NFR-SEC-05).
  @Throttle({ [DEFAULT_THROTTLER]: UPLOAD_THROTTLE })
  // Interceptors run after the auth guard, so an unauthenticated request is rejected
  // before its body is read. Exceeding `fileSize` makes Nest answer 413 "File too large";
  // any other limit (extra files, fields or parts) is a 400.
  @UseInterceptors(FileInterceptor(UPLOAD_FILE_FIELD, { limits: MULTIPART_LIMITS }))
  @ApiCookieAuth(ID_TOKEN_COOKIE)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a post media file or an avatar',
    description:
      'Posts: JPEG, PNG or WebP up to 5 MB, or MP4 or WebM up to 25 MB. Avatars: JPEG, PNG ' +
      'or WebP up to 5 MB. The type is detected from the file contents; the file name and ' +
      'declared type are ignored. Use the returned `path` to create the post.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: [UPLOAD_FILE_FIELD, 'purpose'],
      properties: {
        [UPLOAD_FILE_FIELD]: { type: 'string', format: 'binary' },
        purpose: { type: 'string', enum: [...UPLOAD_PURPOSES] },
      },
    },
  })
  @ApiCreatedResponse({ type: UploadResponseDto, description: 'The file was stored.' })
  @ApiErrorResponses(
    {
      status: HttpStatus.BAD_REQUEST,
      description: 'Missing file, invalid purpose, or a file type not allowed for the purpose.',
    },
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    {
      status: HttpStatus.PAYLOAD_TOO_LARGE,
      description: 'Images over 5 MB, videos over 25 MB.',
    },
    HttpStatus.TOO_MANY_REQUESTS,
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  upload(
    @UploadedFile(new ParseFilePipe({ fileIsRequired: true })) file: UploadedMediaFile,
    @Body() dto: CreateUploadDto,
    @CurrentUser() user: User,
  ): Promise<UploadResponseDto> {
    return this.uploads.upload(user.id, dto.purpose, file);
  }
}
