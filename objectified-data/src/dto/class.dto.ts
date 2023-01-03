import {ApiProperty} from '@nestjs/swagger';

export class ClassDto {
  @ApiProperty({
    description: 'ID of the `Class` object.  If the ID is not set (null), an ID will automatically be assigned.',
    nullable: true,
  })
  id?: number;

  @ApiProperty({
    description: 'Name of the `Class` - up to 80 characters in length.',
    nullable: false,
    required: true,
  })
  name: string;

  @ApiProperty({
    description: 'Description of the `Class` - up to 4096 characters in length.',
    nullable: false,
    required: true,
  })
  description: string;

  @ApiProperty({
    description: 'Flag indicating whether or not the class has been deleted.  This flag can be set back to `true` ' +
      'in order to perform an undelete if desired.  When the value is re-enabled, the delete date will be removed from ' +
      'the record.',
    default: true,
  })
  enabled: boolean = true;

  @ApiProperty({
    description: 'Date record indicating the date and time this `Class` was created.',
    nullable: false,
    required: true,
    default: new Date(),
  })
  createDate: Date = new Date();

  @ApiProperty({
    description: 'Date record indicating the date and time this `Class` was updated.',
    nullable: true,
    required: false,
  })
  updateDate: Date;

  @ApiProperty({
    description: 'Date record indicating the date and time this `Class` was deleted.',
    nullable: true,
    required: false,
  })
  deleteDate: Date;

}