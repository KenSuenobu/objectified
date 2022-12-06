import {Injectable} from '@nestjs/common';
import {ClassPropertyDto} from '../dto/class-property.dto';

@Injectable()
export class ClassPropertiesService {
  createClassProperty(classId: number, propertyId: number): Promise<ClassPropertyDto> {
    throw new Error('Unimplemented');
  }

  addPropertyToClassProperty(classPropertyId: number, propertyId: number): Promise<ClassPropertyDto> {
    throw new Error('Unimplemented');
  }

  getClassProperties(classId: number): Promise<ClassPropertyDto> {
    throw new Error('Unimplemented');
  }

  removePropertyFromClassProperty(classId: number, propertyId: number): Promise<ClassPropertyDto> {
    throw new Error('Unimplemented');
  }

  removeAllClassProperties(classId: number) {
    throw new Error('Unimplemented');
  }
}