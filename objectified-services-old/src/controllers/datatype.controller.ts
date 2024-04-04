import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Logger,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { DataTypeDto } from 'objectified-data/dist/src/dto/datatype.dto';
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { DatatypeService } from '../services/datatype.service';
import { NamespaceDto } from 'objectified-data/dist/src/dto/namespace.dto';

@ApiTags('data-types')
@Controller('data-types')
export class DatatypeController {
  private readonly logger = new Logger('datatype.controller');

  constructor(private readonly service: DatatypeService) {}

  @Post('/create/')
  @ApiBody({
    description: 'The data type to create',
    type: DataTypeDto,
  })
  @ApiOperation({
    summary: 'Creates a Data Type',
    description:
      'Creates a new `DataType` definition in the `Objectified` system layer.  `DataType`s contain ' +
      'definitions different types of data that a `Field` can contain.',
  })
  @ApiCreatedResponse({
    status: HttpStatus.CREATED,
    type: DataTypeDto,
  })
  @ApiConflictResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async createDataType(@Body() payload: DataTypeDto): Promise<DataTypeDto> {
    return this.service.createDataType(payload);
  }

  @Get('/:id/byId')
  @ApiParam({
    name: 'id',
    description: 'The ID of the data type to retrieve',
  })
  @ApiOperation({
    summary: 'Retrieves a data type by ID',
    description: 'Retrieves a data type by its numeric `DataType` ID.',
  })
  @ApiOkResponse({
    status: HttpStatus.OK,
    type: DataTypeDto,
  })
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async getDataTypeById(@Param('id') id: number): Promise<DataTypeDto> {
    return this.service.getDataTypeById(id);
  }

  @Get('/:name/byName')
  @ApiParam({
    name: 'id',
    description: 'The name of the data type to retrieve',
  })
  @ApiOperation({
    summary: 'Retrieves a data type by name',
    description: 'Retrieves a data type by its `DataType` name.',
  })
  @ApiOkResponse({
    status: HttpStatus.OK,
    type: DataTypeDto,
  })
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async getDataType(@Param('name') name: string): Promise<DataTypeDto> {
    return this.service.getDataTypeByName(name);
  }

  @Get('/list')
  @ApiOperation({
    summary: 'Retrieves a list of data types',
    description:
      'Retrieves all of the `DataType` objects stored in `Objectified`.',
  })
  @ApiOkResponse({
    status: HttpStatus.OK,
    type: DataTypeDto,
    isArray: true,
  })
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async listDataTypes(): Promise<DataTypeDto[]> {
    return this.service.listDataTypes();
  }

  @Put('/:id/edit')
  @ApiParam({
    name: 'id',
    description: 'The ID of the data type to modify',
  })
  @ApiBody({
    description: 'The data type to replace the existing object with.',
    type: DataTypeDto,
  })
  @ApiOperation({
    summary: 'Replaces a Data Type by ID',
    description: 'Replaces the Data Type at the given ID.',
  })
  @ApiNoContentResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async editDataType(
    @Param('id') id: number,
    @Body() payload: DataTypeDto,
  ): Promise<boolean> {
    return this.service.editDataType(id, payload);
  }

  @Get('/find/:value')
  @ApiOperation({
    summary: 'Searches for a Namespace',
    description:
      'Searches for `Namespace`s by both the name and description based on the value provided.  Namespace ' +
      'searches are case-insensitive.',
  })
  @ApiOkResponse({
    status: HttpStatus.CREATED,
    type: NamespaceDto,
    isArray: true,
  })
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async findNamespaces(@Param('value') value: string): Promise<DataTypeDto[]> {
    return this.service.findDataTypes(value);
  }
}
