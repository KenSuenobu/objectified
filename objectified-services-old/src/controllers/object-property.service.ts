import {Injectable} from '@nestjs/common';
import {PropertyDto} from '../../../objectified-data/src/dto/property.dto';
import {ObjectPropertyDto} from '../../../objectified-data/src/dto/object-property.dto';

@Injectable()
export class ObjectPropertiesService {
  createObjectProperty(name: string, description: string): Promise<PropertyDto> {
    throw new Error('Unimplemented');
  }

  addPropertyToObject(rootPropertyId: number, childPropertyId: number): Promise<ObjectPropertyDto> {
    throw new Error('Unimplemented');
  }

  removePropertyFromObject(rootPropertyId: number, childPropertyId: number): Promise<ObjectPropertyDto> {
    throw new Error('Unimplemented');
  }

  removeObjectProperty(rootPropertyId: number) {
    throw new Error('Unimplemented');
  }

  getObjectProperty(name: string): Promise<ObjectPropertyDto> {
    throw new Error('Unimplemented');
  }
}