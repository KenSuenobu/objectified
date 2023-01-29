import { ClassPropertyDto } from 'objectified-data/dist/src/dto/class-property.dto';
import {
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
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ClassPropertiesService } from '../services/class-property.service';

@ApiTags('class-properties')
@Controller('class-properties')
export class ClassPropertiesController {
  private readonly logger = new Logger('class-property.controller');

  constructor(private readonly service: ClassPropertiesService) {}

  @Post('/create/:classId/:propertyId')
  @ApiParam({
    name: 'classId',
    description: 'The ID of the class ID',
  })
  @ApiParam({
    name: 'propertyId',
    description: 'The ID of the property ID',
  })
  @ApiOperation({
    summary: 'Creates a Class Property container',
    description:
      'Creates a new `ClassProperty` definition in the `Objectified` system layer.  This assigns ' +
      'properties to classes.',
  })
  @ApiCreatedResponse({
    status: HttpStatus.CREATED,
    type: ClassPropertyDto,
  })
  @ApiConflictResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async createClassProperty(
    @Param('classId') classId: number,
    @Param('propertyId') propertyId: number,
  ): Promise<boolean> {
    return this.service
      .createClassProperty(classId, propertyId)
      .then(() => true);
  }

  @Put('/add/:classId/:propertyId')
  @ApiParam({
    name: 'classId',
    description: 'The ID of the class',
  })
  @ApiParam({
    name: 'propertyId',
    description: 'The ID of the property',
  })
  @ApiOperation({
    summary: 'Adds a Class Property',
    description: 'Adds a `Property` to a `Class`.',
  })
  @ApiOkResponse({
    status: HttpStatus.OK,
    type: ClassPropertyDto,
  })
  @ApiConflictResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async addPropertyToClassProperty(
    @Param('classId') classId: number,
    @Param('propertyId') propertyId: number,
  ): Promise<ClassPropertyDto> {
    return this.service.addPropertyToClassProperty(classId, propertyId);
  }

  @Get('/get/:classId')
  @ApiParam({
    name: 'classId',
    description: 'The ID of the class ID',
  })
  @ApiOperation({
    summary: 'Retrieves the Class Property object based on the Class ID',
    description:
      'Retrieves the `ClassProperty` object based on the root `Class` ID.',
  })
  @ApiOkResponse({
    status: HttpStatus.OK,
    type: ClassPropertyDto,
  })
  @ApiConflictResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async getClassProperties(
    @Param('classId') classId: number,
  ): Promise<ClassPropertyDto> {
    return this.service.getClassProperties(classId);
  }

  @Delete('/delete/:classId/:propertyId')
  @ApiParam({
    name: 'classId',
    description: 'The ID of the class',
  })
  @ApiParam({
    name: 'propertyId',
    description: 'The ID of the property',
  })
  @ApiOperation({
    summary: 'Removes a Class Property',
    description: 'Removes a `Property` from a `Class`.',
  })
  @ApiOkResponse({
    status: HttpStatus.OK,
    type: ClassPropertyDto,
  })
  @ApiConflictResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async removePropertyFromClassProperty(
    @Param('classId') classId: number,
    @Param('propertyId') propertyId: number,
  ): Promise<ClassPropertyDto> {
    return this.service.removePropertyFromClassProperty(classId, propertyId);
  }

  @Delete('/delete/:classId')
  @ApiParam({
    name: 'classId',
    description: 'The ID of the class',
  })
  @ApiOperation({
    summary: 'Removes a Class Property',
    description: 'Removes a `ClassProperty` object by its ID.',
  })
  @ApiOkResponse()
  @ApiConflictResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async removeAllClassProperties(@Param('classId') classId: number) {
    return this.service.removeAllClassProperties(classId);
  }
}
