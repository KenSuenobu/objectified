import {ApiProperty} from '@nestjs/swagger';
import {DataTypeDto} from './datatype.dto';
import {PropertyDto} from './property.dto';

export class ObjectPropertyDao {
  @ApiProperty({
    description: 'ID of the `ObjectProperty` object'
  })
  id: number;

  @ApiProperty({
    description: 'Name of the `ObjectProperty` - up to 80 characters in length.',
    nullable: false,
    required: true,
  })
  name: string;

  @ApiProperty({
    description: 'Description of the `ObjectProperty` - up to 4096 characters in length.',
    nullable: false,
    required: true,
  })
  description: string;

  @ApiProperty({
    description: 'The `Property` objects that this object contains - can also point to other properties, ' +
      'as long as the `DataType` of each property is of `OBJECT` type.',
    nullable: false,
    required: true,
    isArray: true,
    type: PropertyDto,
  })
  propertyList: PropertyDto[];
}