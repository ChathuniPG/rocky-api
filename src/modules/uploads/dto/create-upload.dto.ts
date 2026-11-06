import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { UPLOAD_PURPOSES, type UploadPurpose } from '../uploads.constants';

/** Text fields of the multipart body of POST /uploads; the file itself is the `file` part. */
export class CreateUploadDto {
  @ApiProperty({ enum: UPLOAD_PURPOSES, example: 'post' })
  @IsIn(UPLOAD_PURPOSES, { message: `purpose must be one of: ${UPLOAD_PURPOSES.join(', ')}` })
  purpose: UploadPurpose;
}
