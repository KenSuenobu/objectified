import {ApiProperty} from '@nestjs/swagger';
import {NamespaceDto} from './namespace.dto';
import {ClassDto} from './class.dto';

export class InstanceDto {
  @ApiProperty({
    description: 'The ID of the instance',
  })
  id: number = 0;

  @ApiProperty({
    description: 'Namespace assigned to the class',
    nullable: false,
    required: true,
    type: NamespaceDto,
  })
  namespace: NamespaceDto;

  @ApiProperty({
    description: 'Name of the instance',
    nullable: false,
    required: true,
  })
  name: string;

  @ApiProperty({
    description: 'Description for the instance',
    nullable: false,
    required: true,
  })
  description: string;

  @ApiProperty({
    description: 'The class for which this data was created',
    type: ClassDto,
    nullable: false,
    required: true,
  })
  class: ClassDto;

  @ApiProperty({
    description: 'Flag indicating whether or not the field has been deleted',
    default: true,
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
  })
  updateDate: Date;

  @ApiProperty({
    description: 'Date and time of deletion',
    nullable: true,
  })
  deleteDate: Date;

}