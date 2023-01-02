import {InstanceDto} from './instance.dto';
import {ApiProperty} from '@nestjs/swagger';

export class InstanceDataDto {
  @ApiProperty({
    description: 'ID of the data instance',
  })
  id: number = 0;

  @ApiProperty({
    description: 'The instance for which this data applies',
    type: InstanceDto,
    nullable: false,
    required: true,
  })
  instance: InstanceDto;

  @ApiProperty({
    description: 'Freeform data stored in the instance',
    nullable: true,
  })
  instanceData: any;

  @ApiProperty({
    description: 'Data instance sequence number',
    nullable: false,
  })
  instanceVersion: number;

  @ApiProperty({
    description: 'Date in which this instance data was created',
    type: Date,
    nullable: true,
  })
  date: Date;

}