import {Body, Controller, Get, HttpStatus, Logger, Param, Post, Put} from '@nestjs/common';
import {DataTypeDto} from '../dto/datatype.dto';
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse, ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam, ApiTags,
  ApiUnauthorizedResponse
} from '@nestjs/swagger';
import {DatatypeService} from './datatype.service';

@ApiTags('data-types')
@Controller('data-types')
export class DatatypeController {
  private readonly logger = new Logger('datatype.controller');

  constructor(private readonly classService: DatatypeService) { }

  @Post('/create/')
  @ApiBody({
    description: 'The data type to create',
    type: DataTypeDto,
  })
  @ApiOperation({
    summary: 'Creates a Data Type',
    description: 'Creates a new `DataType` definition in the `Objectified` system layer.  `DataType`s contain ' +
      'definitions different types of data that a `Field` can contain.'
  })
  @ApiCreatedResponse({
    status: HttpStatus.CREATED,
    type: DataTypeDto,
  })
  @ApiConflictResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  createDataType(@Body() payload: DataTypeDto): Promise<DataTypeDto> {
    return this.classService.createDataType(payload);
  }

  @Get('/:id')
  @ApiParam({
    name: 'id',
    description: 'The ID of the data type to retrieve',
  })
  @ApiOperation({
    summary: 'Retrieves a data type by ID',
    description: 'Retrieves a data type by its numeric `DataType` ID.'
  })
  @ApiOkResponse({
    status: HttpStatus.OK,
    type: DataTypeDto,
  })
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  getDataType(@Param('id') id: number): Promise<DataTypeDto> {
    return this.classService.getDataType(id);
  }

  @Get('/list')
  @ApiOperation({
    summary: 'Retrieves a list of data types',
    description: 'Retrieves all of the `DataType` objects stored in `Objectified`.',
  })
  @ApiOkResponse({
    status: HttpStatus.OK,
    type: DataTypeDto,
    isArray: true,
  })
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  listDataTypes(): Promise<DataTypeDto[]> {
    return this.classService.listDataTypes();
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
  editDataType(@Param('id') id: number, @Body() payload: DataTypeDto): Promise<boolean> {
    return this.editDataType(id, payload);
  }


}