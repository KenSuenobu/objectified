import { Injectable } from '@nestjs/common';
import { PropertyDto } from 'objectified-data/dist/src/dto/property.dto';
import { ObjectPropertyDto } from 'objectified-data/dist/src/dto/object-property.dto';
import { DaoUtils } from 'objectified-data/dist/src/dao/dao-utils';
import { PropertyDao } from 'objectified-data/dist/src/dao/property.dao';
import { DataTypeDao } from 'objectified-data/dist/src/dao/datatype.dao';
import { FieldDao } from 'objectified-data/dist/src/dao/field.dao';

@Injectable()
export class ObjectPropertiesService {
  async createObjectProperty(
    name: string,
    description: string,
  ): Promise<PropertyDto> {
    const dao = new PropertyDao(DaoUtils.getDatabase());
    const fieldDao = new FieldDao(DaoUtils.getDatabase());
    const dataTypeDao = new DataTypeDao(DaoUtils.getDatabase());
    const objectDataType = await dataTypeDao.getByName('object');
    throw new Error('Unimplemented');
  }

  addPropertyToObject(
    rootPropertyId: number,
    childPropertyId: number,
  ): Promise<ObjectPropertyDto> {
    throw new Error('Unimplemented');
  }

  removePropertyFromObject(
    rootPropertyId: number,
    childPropertyId: number,
  ): Promise<ObjectPropertyDto> {
    throw new Error('Unimplemented');
  }

  removeObjectProperty(rootPropertyId: number) {
    throw new Error('Unimplemented');
  }

  getObjectProperty(name: string): Promise<ObjectPropertyDto> {
    throw new Error('Unimplemented');
  }
}
