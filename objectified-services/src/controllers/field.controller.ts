import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Logger,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { FieldsService } from '../services/field.service';
import { FieldDto } from 'objectified-data/dist/src/dto/field.dto';

@ApiTags('fields')
@Controller('fields')
export class FieldsController {
  private readonly logger = new Logger('fields.controller');

  constructor(private readonly service: FieldsService) {}

  @Post('/create')
  @ApiBody({
    description: 'The field to create',
    type: FieldDto,
  })
  @ApiOperation({
    summary: 'Creates a Field',
    description:
      'Creates a new `Field` definition in the `Objectified` system layer.  `Field`s contain ' +
      'definitions that define `Property` objects.',
  })
  @ApiCreatedResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  @ApiConflictResponse()
  async createField(@Body() payload: FieldDto): Promise<FieldDto> {
    return this.service.createField(payload);
  }

  @Get('/:id/byId')
  @ApiOperation({
    summary: 'Retrieves a field by ID',
    description: 'Retrieves a full `Field` object by its ID',
  })
  @ApiParam({
    name: 'id',
    description: 'The ID of the field',
  })
  @ApiOkResponse({
    status: HttpStatus.OK,
    type: FieldDto,
  })
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async getFieldById(@Param('id') id: number): Promise<FieldDto> {
    return this.service.getFieldById(id);
  }

  @Get('/:name/byName')
  @ApiOperation({
    summary: 'Retrieves a field by name or description',
    description: 'Retrieves a full `Field` object by its name or description',
  })
  @ApiParam({
    name: 'id',
    description: 'The name of the field',
  })
  @ApiOkResponse({
    status: HttpStatus.OK,
    type: FieldDto,
  })
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async getFieldByName(@Param('name') name: string): Promise<FieldDto> {
    return this.service.getFieldByName(name);
  }

  @Get('/list')
  @ApiOperation({
    summary: 'Retrieves all fields',
    description: 'Retrieves a list of all `Field`s in the Objectified system.',
  })
  @ApiOkResponse({
    status: HttpStatus.OK,
    type: FieldDto,
    isArray: true,
  })
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async listFields(): Promise<FieldDto[]> {
    return this.service.listFields();
  }

  @Put('/:id/edit')
  @ApiBody({
    description: 'The field to edit',
    type: FieldDto,
  })
  @ApiOperation({
    summary: 'Edits a Field',
    description: 'Edits a `Field` object.',
  })
  @ApiParam({
    name: 'id',
    description: 'The ID of the field',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async editField(@Param('id') id: number, @Body() payload: FieldDto) {
    return this.service.editField(id, payload);
  }

  @Delete('/:id')
  @ApiParam({
    name: 'id',
    description: 'The ID of the field',
  })
  @ApiOperation({
    summary: 'Deletes a Field',
    description: 'Sets a `Field` disabled status, deleting the field.',
  })
  @ApiOkResponse()
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async deleteField(@Param('id') id: number) {
    return this.service.deleteField(id);
  }
}
