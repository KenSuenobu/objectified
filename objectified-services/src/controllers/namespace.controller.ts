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
import { NamespacesService } from '../services/namespace.service';
import { NamespaceDto } from 'objectified-data/dist/src/dto/namespace.dto';

@ApiTags('namespaces')
@Controller('namespaces')
export class NamespacesController {
  private readonly logger = new Logger('namespace.controller');

  constructor(private readonly service: NamespacesService) {}

  @Post('/create')
  @ApiBody({
    description: 'The namespace to create',
    type: NamespaceDto,
  })
  @ApiOperation({
    summary: 'Creates a Namespace',
    description:
      'Creates a new `Namespace` definition in the `Objectified` system layer.  `Namespaces`s ' +
      'create logical divisions between ownership of large objects, and object definitions.',
  })
  @ApiCreatedResponse({
    status: HttpStatus.CREATED,
    type: NamespaceDto,
  })
  @ApiConflictResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async createNamespace(@Body() payload: NamespaceDto): Promise<NamespaceDto> {
    return this.service.createNamespace(payload);
  }

  @Put('/:id/edit')
  @ApiParam({
    name: 'id',
    description: 'The ID of the `Namespace` to modify',
  })
  @ApiBody({
    description: 'The `Namespace` to edit',
    type: NamespaceDto,
  })
  @ApiOperation({
    summary: 'Edits a Namespace',
    description: 'Edits a `Namespace` entry by its ID.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async editNamespace(@Param('id') id: number, @Body() payload: NamespaceDto) {
    return this.service.editNamespace(id, payload);
  }

  @Delete('/:id')
  @ApiParam({
    name: 'id',
    description: 'The ID of the `Namespace` to delete',
  })
  @ApiOperation({
    summary: 'Deletes a Namespace',
    description: 'Deletes a `Namespace` entry by its ID.',
  })
  @ApiOkResponse()
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async deleteNamespace(@Param('id') id: number) {
    return this.service.deleteNamespace(id);
  }

  @Get('/:id/byId')
  @ApiParam({
    name: 'id',
    description: 'The ID of the `Namespace` to get',
  })
  @ApiOperation({
    summary: 'Retrieves a Namespace by its ID',
    description: 'Retrieves a `Namespace` entry by its ID.',
  })
  @ApiOkResponse({
    status: HttpStatus.OK,
    type: NamespaceDto,
  })
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async getNamespace(@Param('id') id: number): Promise<NamespaceDto> {
    return this.service.getNamespace(id);
  }

  @Get('/:name/byName')
  @ApiParam({
    name: 'name',
    description: 'The name of the `Namespace` to get',
  })
  @ApiOperation({
    summary: 'Retrieves a Namespace by its name',
    description: 'Retrieves a `Namespace` entry by its name.',
  })
  @ApiOkResponse({
    status: HttpStatus.OK,
    type: NamespaceDto,
  })
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async getNamespaceByName(@Param('name') name: string): Promise<NamespaceDto> {
    return this.service.getNamespaceByName(name);
  }

  @Get('/list')
  @ApiOperation({
    summary: 'Lists all Namespaces',
    description:
      'Retrieves a list of all `Namespaces` registered in `Objectified`',
  })
  @ApiOkResponse({
    status: HttpStatus.OK,
    type: NamespaceDto,
    isArray: true,
  })
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async listNamespaces(): Promise<NamespaceDto[]> {
    return this.service.listNamespaces();
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
  async findNamespaces(@Param('value') value: string): Promise<NamespaceDto[]> {
    return this.service.findNamespaces(value);
  }
}
