import { Injectable } from '@nestjs/common';
import { PropertyDto } from 'objectified-data/dist/src/dto/property.dto';
import { ObjectPropertyDto } from 'objectified-data/dist/src/dto/object-property.dto';
import { DaoUtils } from 'objectified-data/dist/src/dao/dao-utils';
import { PropertyDao } from 'objectified-data/dist/src/dao/property.dao';
import { DataTypeDao } from 'objectified-data/dist/src/dao/datatype.dao';
import { FieldDao } from 'objectified-data/dist/src/dao/field.dao';
import {FieldDto} from 'objectified-data/dist/src/dto/field.dto';
import {ClassPropertyDto} from 'objectified-data/dist/src/dto/class-property.dto';
import {ObjectPropertyDao} from 'objectified-data/dist/src/dao/object-property.dao';

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
    let fieldObject = new FieldDto();

    fieldObject.dataType = objectDataType;
    fieldObject.name = name;
    fieldObject.description = description;
    fieldObject = await fieldDao.create(fieldObject);

    const propertyObject = new PropertyDto();

    propertyObject.field = fieldObject;
    propertyObject.name = name;
    propertyObject.description = description;

    return dao.create(propertyObject);
  }

  addPropertyToObject(
    rootPropertyId: number,
    childPropertyId: number,
  ) {
    const dao = new ObjectPropertyDao(DaoUtils.getDatabase());
    const propertyObject = new ObjectPropertyDto();
    const rootProperty = new PropertyDto();
    const childProperty = new PropertyDto();

    rootProperty.id = rootPropertyId;
    childProperty.id = childPropertyId;
    propertyObject.parent = rootProperty;
    propertyObject.propertyList.push(childProperty);

    return dao.create(propertyObject);
  }

  removePropertyFromObject(
    rootPropertyId: number,
    childPropertyId: number,
  ) {
    const dao = new ObjectPropertyDao(DaoUtils.getDatabase());

    return dao.deletePropertyFromObject(rootPropertyId, childPropertyId);
  }

  removeObjectProperty(rootPropertyId: number) {
    throw new Error('Unimplemented');
  }

  getObjectProperty(name: string): Promise<ObjectPropertyDto> {
    throw new Error('Unimplemented');
  }
}
