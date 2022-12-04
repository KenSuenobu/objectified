import {Body, Controller, Delete, Get, Logger, Param, Post, Put} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiNoContentResponse,
  ApiCreatedResponse,
  ApiBody, ApiForbiddenResponse, ApiUnauthorizedResponse, ApiConflictResponse,
} from "@nestjs/swagger";
import {PropertiesService} from './property.service';
import {PropertyDto} from '../dto/property.dto';

@ApiTags("properties")
@Controller("properties")
export class PropertiesController {
  private readonly logger = new Logger('properties.controller');

  constructor(private readonly service: PropertiesService) {}

  @Post("/create")
  @ApiBody({
    description: "The property to create",
    type: PropertyDto,
  })
  @ApiOperation({
    summary: "Creates a Property",
    description:
      "Creates a new `Property` definition in the `Objectified` system layer.  `Property` contains " +
      "definitions that define `Field`s to assignable data.",
  })
  @ApiCreatedResponse()
  @ApiConflictResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  createProperty(@Body() payload: PropertyDto) {
    return this.service.createProperty(payload);
  }

  @Get("/:id")
  @ApiOperation({
    summary: "Retrieves a property by ID",
    description: "Retrieves a full `Property` object by its ID",
  })
  @ApiParam({
    name: "id",
    description: "The ID of the property",
  })
  @ApiOkResponse()
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  getFieldById(@Param("id") id: number): Promise<PropertyDto> {
    return this.service.getPropertyById(id);
  }

  @Get("/list")
  @ApiOperation({
    summary: "Retrieves all properties",
    description: "Retrieves a list of all `Property` objects in the Objectified system.",
  })
  @ApiOkResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  listProperties(): Promise<PropertyDto[]> {
    return this.service.listProperties();
  }

  @Put("/:id/edit")
  @ApiBody({
    description: "The property to edit",
    type: PropertyDto,
  })
  @ApiOperation({
    summary: "Edits a Property",
    description: "Edits a `Property` object.",
  })
  @ApiParam({
    name: "id",
    description: "The ID of the property",
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  editField(@Param("id") id: number, @Body() payload: PropertyDto) {
    return this.service.editProperty(id, payload);
  }

  @Delete("/:id")
  @ApiParam({
    name: "id",
    description: "The ID of the property",
  })
  @ApiOperation({
    summary: "Deletes a Property",
    description: "Sets a `Property` disabled status, deleting the property.",
  })
  @ApiOkResponse()
  @ApiNotFoundResponse()
  @ApiForbiddenResponse()
  @ApiUnauthorizedResponse()
  deleteField(@Param("id") id: number) {
    return this.service.deleteProperty(id);
  }
}