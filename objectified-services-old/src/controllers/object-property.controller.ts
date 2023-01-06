import {PropertyDto} from '../../../objectified-data/src/dto/property.dto';
import {ObjectPropertyDto} from '../../../objectified-data/src/dto/object-property.dto';
import {Body, Controller, Delete, Get, HttpStatus, Logger, Param, Post, Put} from '@nestjs/common';
import {NamespacesService} from './namespace.service';
import {
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse, ApiNoContentResponse, ApiNotFoundResponse, ApiOkResponse,
  ApiOperation, ApiParam, ApiTags,
  ApiUnauthorizedResponse
} from '@nestjs/swagger';
import {NamespaceDto} from '../../../objectified-data/src/dto/namespace.dto';
import {ObjectPropertiesService} from './object-property.service';
import {ClassDto} from '../../../objectified-data/src/dto/class.dto';

@ApiTags('object-properties')
@Controller('object-properties')
export class ObjectPropertiesController {
  private readonly logger = new Logger('object-properties.controller');

  constructor(private readonly service: ObjectPropertiesService) {}

  @Post('/create')
  @ApiParam({
    name: 'name',
    description: 'The name of the object property to create - 80 characters in length max.',
  })
  @ApiParam({
    name: 'name',
    description: 'The description to assign to the object property - 4096 characters in length max.',
  })
  @ApiOperation({
    summary: 'Creates an Object Property',
    description: 'Creates a new `ObjectProperty` definition in the `Objectified` system layer.  `ObjectProperty` objects ' +
      'allow for complex objects to be added to the `Objectified` system, allowing for objects of objects to be defined ' +
      'in a complex schema.'
  })
  @ApiCreatedResponse({
    status: HttpStatus.CREATED,
    type: PropertyDto,
  })
  @ApiConflictResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async createObjectProperty(@Param('name') name: string, @Param('description') description: string): Promise<PropertyDto> {
    return this.service.createObjectProperty(name, description);
  }

  @Put('/:id/:childId')
  @ApiParam({
    name: 'id',
    description: 'The ID of the object property to attach additional `Property` objects against',
  })
  @ApiParam({
    name: 'childId',
    description: 'The ID of the object property to attach to the root `ObjectProperty` object.  This can be any ' +
      '`Property`, even one that was defined as an `OBJECT`.  Adding an `OBJECT` type will result in a sub-object ' +
      'in the schema, allowing for multiple levels of object complexity.',
  })
  @ApiOperation({
    summary: 'Assigns a property to an object',
    description: 'Adds an additional `Property` to an `ObjectProperty` by its ID.'
  })
  @ApiOkResponse({
    status: HttpStatus.OK,
    type: ObjectPropertyDto,
  })
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async addPropertyToObject(@Param('id') rootPropertyId: number, @Param('childId') childPropertyId: number): Promise<ObjectPropertyDto> {
    return this.service.addPropertyToObject(rootPropertyId, childPropertyId);
  }

  @Delete('/:id/:childId')
  @ApiParam({
    name: 'id',
    description: 'The ID of the object property from which to remove assigned `Property` objects.',
  })
  @ApiParam({
    name: 'childId',
    description: 'The ID of the `Property` to remove from this root object `Property`.',
  })
  @ApiOperation({
    summary: 'Removes a Property assigned to an ObjectProperty',
    description: 'Removes assignment of a `Property` from an `ObjectProperty` object.'
  })
  @ApiOkResponse({
    status: HttpStatus.OK,
    type: ObjectPropertyDto,
  })
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async removePropertyFromObject(@Param('id') rootPropertyId: number, @Param('childId') childPropertyId: number): Promise<ObjectPropertyDto> {
    return this.service.removePropertyFromObject(rootPropertyId, childPropertyId);
  }

  @Delete('/:id')
  @ApiParam({
    name: 'id',
    description: 'The ID of the object property to delete.',
  })
  @ApiOperation({
    summary: 'Deletes a Namespace',
    description: 'Deletes a `Namespace` entry by its ID.'
  })
  @ApiOperation({
    summary: 'Deletes an Object Property',
    description: 'Removes an `ObjectProperty`.  Any `Property` objects assigned to the `ObjectProperty` will also be ' +
      'removed, so use this function with care.'
  })
  @ApiOkResponse()
  async removeObjectProperty(@Param('id') rootPropertyId: number) {
    return this.service.removeObjectProperty(rootPropertyId);
  }

  @Get('/:name')
  @ApiParam({
    name: 'name',
    description: 'The name of the `ObjectProperty` to get.',
  })
  @ApiOperation({
    summary: 'Retrieves an `ObjectProperty` by its name.',
    description: 'Retrieves an `ObjectProperty` by its name.'
  })
  @ApiOkResponse({
    status: HttpStatus.OK,
    type: NamespaceDto,
  })
  @ApiOperation({
    summary: 'Retrieves an ObjectProperty',
    description: 'Retrieves an `ObjectProperty` by its name.'
  })
  @ApiOkResponse({
    status: HttpStatus.OK,
    type: ObjectPropertyDto,
  })
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async getObjectProperty(@Param('name') name: string): Promise<ObjectPropertyDto> {
    throw new Error('Unimplemented');
  }

}