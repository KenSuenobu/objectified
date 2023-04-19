import {ApiProperty} from '@nestjs/swagger';

export class InstanceGroupDto {
  @ApiProperty({
    description: 'ID of the `InstanceGroup` object'
  })
  id: number;

  @ApiProperty({
    description: 'Name of the `InstanceGroup` - up to 80 characters in length.',
    nullable: false,
    required: true,
  })
  name: string;

  @ApiProperty({
    description: 'Description of the `InstanceGroup` - up to 4096 characters in length.',
    nullable: false,
    required: true,
  })
  description: string;

  @ApiProperty({
    description: 'Flag indicating whether or not the field has been deleted',
  })
  enabled: boolean = true;

  @ApiProperty({
    description: 'Date and time of creation',
    default: new Date(),
  })
  createDate: Date;

  @ApiProperty({
    description: 'Date and time of update',
    nullable: true,
    default: null,
  })
  updateDate: Date;

  @ApiProperty({
    description: 'Date and time of deletion',
    nullable: true,
    default: null,
  })
  deleteDate: Date;

}