import {ApiProperty} from '@nestjs/swagger';
import {NamespaceDto} from './namespace.dto';
import {FieldDto} from './field.dto';

export class PropertyDto {
  @ApiProperty({
    description: 'ID of the Property.  If the ID is not set (null), an ID will automatically be assigned.',
  })
  id: number = 0;

  @ApiProperty({
    description: 'Namespace assigned to the property',
    nullable: false,
    required: true,
    type: NamespaceDto,
  })
  namespace: NamespaceDto;

  @ApiProperty({
    description: 'Name of the property - this is also the name of the variable for this property - up to 80 characters in length.',
    nullable: false,
    required: true,
  })
  name: string;

  @ApiProperty({
    description: 'Description of the property - up to 4096 characters in length.',
    nullable: false,
    required: true,
  })
  description: string;

  @ApiProperty({
    description: 'The `Field` that describes the data stored in this `Property`',
    type: FieldDto,
    required: true,
    nullable: false,
  })
  field: FieldDto;

  @ApiProperty({
    description: 'Flag indicating whether or not the property value is required to be assigned',
    default: false,
  })
  required: boolean = false;

  @ApiProperty({
    description: 'Flag indicating whether or not the property accepts a nullable value',
    default: true,
  })
  nullable: boolean = true;

  @ApiProperty({
    description: 'Flag indicating whether or not the values stored are an array of data',
    default: false,
  })
  isArray: boolean = false;

  @ApiProperty({
    description: 'Default value assigned to the property if no value is set',
    nullable: true,
  })
  defaultValue: string;

  @ApiProperty({
    description: 'Indicates whether or not the property is deleted',
    default: true,
  })
  enabled: boolean = true;

  @ApiProperty({
    description: 'Flag indicating whether or not the value of the field is to be indexed',
  })
  indexed: boolean = false;

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