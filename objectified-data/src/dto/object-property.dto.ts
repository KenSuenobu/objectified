import {ApiProperty} from '@nestjs/swagger';
import {PropertyDto} from './property.dto';

export class ObjectPropertyDto {
  @ApiProperty({
    description: 'ID of the `ObjectProperty` object'
  })
  id: number;

  @ApiProperty({
    description: 'The parent `Property` against which to assign additional `Property` objects.',
    nullable: false,
    required: true,
    type: PropertyDto,
  })
  parent: PropertyDto;

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