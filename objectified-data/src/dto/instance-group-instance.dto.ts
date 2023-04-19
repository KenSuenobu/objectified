import {ApiProperty} from '@nestjs/swagger';
import {InstanceDto} from './instance.dto';
import {InstanceGroupDto} from "./instance-group.dto";

export class InstanceGroupInstanceDto {
  @ApiProperty({
    description: 'ID of the `InstanceGroupInstance` object'
  })
  id: number;

  @ApiProperty({
    description: 'Instance Group',
    nullable: false,
    required: true,
  })
  instanceGroup: InstanceGroupDto;

  @ApiProperty({
    description: 'Instances',
    nullable: false,
    required: true,
    isArray: true,
  })
  instances: InstanceDto[];

}