import {ApiProperty} from '@nestjs/swagger';
import {PropertyDto} from './property.dto';
import {ClassDto} from './class.dto';

export class ClassPropertyDto {
  @ApiProperty({
    description: 'ID of the `ClassProperty` object'
  })
  id: number;

  @ApiProperty({
    description: 'The `Class` to which the `Property` objects are assigned.',
    nullable: false,
    required: true,
  })
  class: ClassDto;

  @ApiProperty({
    description: 'The `Property` objects that are part of the `Class`.',
    nullable: false,
    required: true,
    isArray: true,
    type: PropertyDto,
  })
  propertyList: PropertyDto[];

}