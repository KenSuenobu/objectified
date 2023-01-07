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
import { ClassesService } from '../services/class.service';
import { ClassDto } from 'objectified-data/dist/src/dto/class.dto';

@ApiTags('classes')
@Controller('classes')
export class ClassesController {
  private readonly logger = new Logger('class.controller');

  constructor(private readonly service: ClassesService) {}

  @Post('/create')
  @ApiBody({
    description: 'The class to create',
    type: ClassDto,
  })
  @ApiOperation({
    summary: 'Creates a Class',
    description:
      'Creates a new `Class` definition in the `Objectified` system layer.  `Class`es ' +
      'define dynamic data schemas.',
  })
  @ApiCreatedResponse({
    status: HttpStatus.CREATED,
    type: ClassDto,
  })
  @ApiConflictResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async createNamespace(@Body() payload: ClassDto): Promise<ClassDto> {
    return this.service.createClass(payload);
  }

  @Put('/:id/edit')
  @ApiParam({
    name: 'id',
    description: 'The ID of the `Class` to modify',
  })
  @ApiBody({
    description: 'The `Class` to edit',
    type: ClassDto,
  })
  @ApiOperation({
    summary: 'Edits a Class',
    description: 'Edits a `Class` entry by its ID.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async editNamespace(@Param('id') id: number, @Body() payload: ClassDto) {
    return this.service.editClass(id, payload);
  }

  @Delete('/:id')
  @ApiParam({
    name: 'id',
    description: 'The ID of the `Class` to delete',
  })
  @ApiOperation({
    summary: 'Deletes a Class',
    description: 'Deletes a `Class` entry by its ID.',
  })
  @ApiOkResponse()
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async deleteNamespace(@Param('id') id: number) {
    return this.service.deleteClass(id);
  }

  @Get('/:id')
  @ApiParam({
    name: 'id',
    description: 'The ID of the `Class` to get',
  })
  @ApiOperation({
    summary: 'Retrieves a Class by its ID',
    description: 'Retrieves a `Class` entry by its ID.',
  })
  @ApiOkResponse({
    status: HttpStatus.OK,
    type: ClassDto,
  })
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async getNamespace(@Param('id') id: number): Promise<ClassDto> {
    return this.service.getClass(id);
  }

  @Get('/list')
  @ApiOperation({
    summary: 'Lists all Classes',
    description:
      'Retrieves a list of all `Classes` registered in `Objectified`.',
  })
  @ApiOkResponse({
    status: HttpStatus.OK,
    type: ClassDto,
    isArray: true,
  })
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async listNamespaces(): Promise<ClassDto[]> {
    return this.service.listClasses();
  }

  @Get('/find/:value')
  @ApiParam({
    name: 'value',
    description: 'A free-formed string value to search for.',
  })
  @ApiOperation({
    summary: 'Searches for a Class',
    description:
      'Searches for `Class`s by both the name and description based on the value provided.  Class ' +
      'searches are case-insensitive.',
  })
  @ApiOkResponse({
    status: HttpStatus.OK,
    type: ClassDto,
    isArray: true,
  })
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async findNamespaces(@Param('value') value: string): Promise<ClassDto[]> {
    return this.service.findClasses(value);
  }
}
