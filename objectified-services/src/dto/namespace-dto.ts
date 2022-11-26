import { ApiProperty } from "@nestjs/swagger";

export class NamespaceDto {
  @ApiProperty({
    description: 'ID of the `Namespace` object.  If the ID is not set (null), an ID will automatically be assigned.',
    nullable: true,
  })
  id?: number;

  @ApiProperty({
    description: 'Name of the `Namespace` - up to 80 characters in length.',
    nullable: false,
    required: true,
  })
  name: string;

  @ApiProperty({
    description: 'Description of the `Namespace` - up to 4096 characters in length.',
    nullable: false,
    required: true,
  })
  description: string;

  @ApiProperty({
    description: 'Flag indicating whether or not the namespace has been deleted.  This flag can be set back to `true` ' +
      'in order to perform an undelete if desired.',
    default: true,
  })
  enabled: boolean = true;
}