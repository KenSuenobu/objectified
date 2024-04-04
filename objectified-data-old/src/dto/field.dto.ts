import {ApiProperty} from '@nestjs/swagger';
import {DataTypeDto} from './datatype.dto';
import {NamespaceDto} from "./namespace.dto";

export class FieldDto {
  @ApiProperty({
    description: 'ID of the `Field` object'
  })
  id: number;

  @ApiProperty({
    description: 'Namespace associated with the `Field`',
    type: NamespaceDto,
    nullable: false,
    required: true,
  })
  namespace: NamespaceDto;

  @ApiProperty({
    description: 'The Data Type associated with the `Field`',
    type: DataTypeDto,
    nullable: false,
    required: true,
  })
  dataType: DataTypeDto;

  @ApiProperty({
    description: 'Name of the `Field` - up to 80 characters in length.',
    nullable: false,
    required: true,
  })
  name: string;

  @ApiProperty({
    description: 'Description of the `Field` - up to 4096 characters in length.',
    nullable: false,
    required: true,
  })
  description: string;

  @ApiProperty({
    description: 'Default value of the `Field`',
    nullable: false,
    required: true,
  })
  defaultValue: string;

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