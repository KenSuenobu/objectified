import {Body, Controller, Delete, Get, Logger, Param, Patch, Post, Put} from "@nestjs/common";
import {ApiBody, ApiForbiddenResponse, ApiUnauthorizedResponse, ApiConflictResponse, ApiCreatedResponse, ApiOperation, ApiTags} from "@nestjs/swagger";
import {InstancesService} from './instance.service';
import {InstanceDto} from '../dto/instance.dto';
import {InstanceDataDto} from '../dto/instance-data.dto';
import {ApiOkResponse} from '@nestjs/swagger';
import {ApiNotFoundResponse} from '@nestjs/swagger';
import {ApiParam} from '@nestjs/swagger';
import {PropertyDto} from '../dto/property.dto';
import {FieldDto} from '../dto/field.dto';

@ApiTags('instances')
@Controller('instances')
export class InstancesController {
  private readonly logger = new Logger('instances.controller');

  constructor(private readonly service: InstancesService) {}

  @Post("/create")
  @ApiBody({
    description: "The instance to create",
    type: InstanceDto,
  })
  @ApiOperation({
    summary: "Creates a new Instance",
    description:
      "Creates a new `Instance` record.  `Instance`s hold records of data, as well as the metadata records for each " +
      "data record.",
  })
  @ApiCreatedResponse()
  @ApiConflictResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async createInstance(@Body() payload: InstanceDto): Promise<InstanceDto> {
    return this.service.createInstance(payload);
  }

  @Put("/create/data")
  @ApiBody({
    description: "The instance data to create",
    type: InstanceDataDto,
  })
  @ApiOperation({
    summary: "Assigns instance data to an instance",
    description:
      "Creates an `InstanceData` object to an `Instance`.  Adds a data record: if the first record is added, the " +
      "create date is set.  If additional records are added, the updated date is updated.",
  })
  @ApiCreatedResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async createInstanceData(@Body() payload: InstanceDataDto) {
    return this.service.createInstanceData(payload);
  }

  @Delete("/:id")
  @ApiOperation({
    summary: "Deletes an Instance",
    description: "Sets the deleted instance date for a record.  Data that is deleted is simply marked as deleted, but " +
      "it is not physically deleted from the database.",
  })
  @ApiParam({
    name: "id",
    description: "The ID of the instance",
  })
  @ApiOkResponse()
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async deleteInstance(@Param('id') id: number) {
    return this.service.deleteInstance(id);
  }

  @Patch("/:id")
  @ApiOperation({
    summary: "Undeletes an Instance",
    description: "Removes the deleted date record from the database, but records an additional copy of the last " +
      "`InstanceData` record that was added (if applicable) with the new updated date.",
  })
  @ApiParam({
    name: "id",
    description: "The ID of the instance",
  })
  @ApiOkResponse()
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async undeleteInstance(@Param('id') id: number) {
    return this.service.undeleteInstance(id);
  }

  @Get('/:id/instance')
  @ApiOperation({
    summary: "Retrieves an Instance",
    description: "Retrieves an instance object by its ID",
  })
  @ApiParam({
    name: "id",
    description: "The ID of the instance",
  })
  @ApiOkResponse()
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async getInstanceByName(@Param('name') name: string): Promise<InstanceDto> {
    return this.service.getInstanceByName(name);
  }

  @Get('/:id/data/latest')
  @ApiOperation({
    summary: "Retrieves the latest data record for an instance by ID",
    description: "Retrieves the last data record in an instance by the specified `Instance` ID.",
  })
  @ApiParam({
    name: "id",
    description: "The ID of the instance",
  })
  @ApiOkResponse()
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async getLatestInstanceDataForInstance(@Param('id') id: number): Promise<InstanceDataDto> {
    return this.service.getLatestInstanceDataForInstance(id);
  }

  @Get('/:id/data/all')
  @ApiOperation({
    summary: "Retrieves all data records for an instance by ID",
    description: "Retrieves data records in an instance by the specified `Instance` ID.",
  })
  @ApiParam({
    name: "id",
    description: "The ID of the instance",
  })
  @ApiOkResponse()
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async getAllInstanceDataForInstance(@Param('id') id: number): Promise<InstanceDataDto[]> {
    return this.service.getAllInstanceDataForInstance(id);
  }

  @Get('/:search/data/by-property')
  @ApiOperation({
    summary: "Searches for instance data by the value of a property",
    description: "Searches for a value in a `Property` field of an `InstanceData` record.",
  })
  @ApiBody({
    description: "The property to search by",
    type: PropertyDto,
  })
  @ApiParam({
    name: "search",
    description: "A search string to use",
  })
  @ApiOkResponse()
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async findInstanceByPropertyValue(@Body() property: PropertyDto, @Param('search') search: string): Promise<InstanceDataDto[]> {
    return this.service.findInstanceByPropertyValue(property, search);
  }

  @Get('/:search/data/by-field')
  @ApiOperation({
    summary: "Searches for instance data by the value of a field",
    description: "Searches for a value in a `Field` of an `InstanceData` record.",
  })
  @ApiBody({
    description: "The field to search by",
    type: FieldDto,
  })
  @ApiParam({
    name: "search",
    description: "A search string to use",
  })
  @ApiOkResponse()
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  async findInstanceByFieldValue(@Body() field: FieldDto, @Param('search') search: string): Promise<InstanceDataDto[]> {
    return this.service.findInstanceByFieldValue(field, search);
  }

}