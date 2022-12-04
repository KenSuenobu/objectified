import {Injectable} from '@nestjs/common';
import {PropertyDto} from '../dto/property.dto';
import {ObjectPropertyDao} from '../dto/object-property.dao';

@Injectable()
export class ObjectPropertiesService {
  createObjectProperty(name: string, description: string): Promise<PropertyDto> {
    throw new Error('Unimplemented');
  }

  addPropertyToObject(rootPropertyId: number, childPropertyId: number): Promise<ObjectPropertyDao> {
    throw new Error('Unimplemented');
  }

  removePropertyFromObject(rootPropertyId: number, childPropertyId: number): Promise<ObjectPropertyDao> {
    throw new Error('Unimplemented');
  }

  removeObjectProperty(rootPropertyId: number) {
    throw new Error('Unimplemented');
  }

  getObjectProperty(name: string): Promise<ObjectPropertyDao> {
    throw new Error('Unimplemented');
  }
}