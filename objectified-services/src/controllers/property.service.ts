import {Injectable, Logger} from "@nestjs/common";
import {PropertyDto} from '../dto/property.dto';

@Injectable()
export class PropertiesService {
  private readonly logger = new Logger('properties.service');

  createProperty(payload: PropertyDto): Promise<PropertyDto> {
    throw new Error('Unimplemented');
  }

  getPropertyById(id: number): Promise<PropertyDto> {
    throw new Error('Unimplemented');
  }

  listProperties(): Promise<PropertyDto[]> {
    throw new Error('Unimplemented');
  }

  editProperty(id: number, payload: PropertyDto) {
    throw new Error('Unimplemented');
  }

  deleteProperty(id: number) {
    throw new Error('Unimplemented');
  }
}