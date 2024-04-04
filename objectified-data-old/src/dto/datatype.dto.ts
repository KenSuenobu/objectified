import {ApiProperty} from '@nestjs/swagger';

enum DataTypeEnum {
  STRING,
  INT32,
  INT64,
  FLOAT,
  DOUBLE,
  BOOLEAN,
  DATE,
  DATE_TIME,
  BYTE,
  BINARY,
  PASSWORD,
}

export class DataTypeDto {
  @ApiProperty({
    description: "Data type ID",
    default: 0,
  })
  id: number = 0;

  @ApiProperty({
    description: "Name of the Data Type",
    nullable: false,
    required: true,
  })
  name: string;

  @ApiProperty({
    description: "Data Type description",
    nullable: false,
    required: true,
  })
  description: string;

  @ApiProperty({
    description: "Data Type",
    enum: DataTypeEnum,
    required: true,
  })
  dataType: DataTypeEnum;

  @ApiProperty({
    description: "Indicates whether or not the data type is an array of values",
    default: false,
  })
  isArray: boolean = false;

  @ApiProperty({
    description: "Max allowed length of the data type",
    default: 0,
  })
  maxLength: number = 0;

  @ApiProperty({
    description: "Regular Expression pattern that is applied to the Data Type",
    nullable: true,
  })
  pattern: string | null;

  @ApiProperty({
    description: "Enumeration values applicable to this Data Type",
    isArray: true,
    nullable: true,
  })
  enumValues: string[] | null;

  @ApiProperty({
    description: "Enumeration descriptions applicable to the enumeration definitions, one-for-one match",
    isArray: true,
    nullable: true,
  })
  enumDescriptions: string[] | null;

  @ApiProperty({
    description: "Examples that apply to this data type",
    isArray: true,
    nullable: true,
  })
  examples: string[] | null;

  @ApiProperty({
    description: 'Indicates whether or not the data type is deleted',
    default: true,
  })
  enabled: boolean = true;

  @ApiProperty({
    description: 'Indicates whether or not the data type is a core type',
    default: false,
  })
  coreType: boolean = false;

  @ApiProperty({
    description: 'Date and time of creation',
    default: new Date(),
    required: true,
  })
  createDate: Date;

  @ApiProperty({
    description: 'Date and time of update',
    nullable: true,
    required: false,
  })
  updateDate: Date;

  @ApiProperty({
    description: 'Date and time of deletion',
    nullable: true,
    required: false,
  })
  deleteDate: Date;

}
