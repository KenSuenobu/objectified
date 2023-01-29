import { Injectable } from '@nestjs/common';
import { ClassPropertyDto } from 'objectified-data/dist/src/dto/class-property.dto';
import { DaoUtils } from 'objectified-data/dist/src/dao/dao-utils';
import { ClassDao } from 'objectified-data/dist/src/dao/class.dao';
import { PropertyDao } from 'objectified-data/dist/src/dao/property.dao';
import { ClassPropertyDao } from 'objectified-data/dist/src/dao/class-property.dao';
import { ClassPropertiesDao } from 'objectified-data/dist/src/dao/class-properties.dao';

@Injectable()
export class ClassPropertiesService {
  async createClassProperty(classId: number, propertyId: number) {
    const dao = new ClassPropertyDao(DaoUtils.getDatabase());
    const classDao = new ClassDao(DaoUtils.getDatabase());
    const propertyDao = new PropertyDao(DaoUtils.getDatabase());
    const classDto = await classDao.getById(classId);
    const propertyDto = await propertyDao.getById(propertyId);
    const classPropertyDto = new ClassPropertyDto();

    classPropertyDto.class = classDto;
    classPropertyDto.propertyList.push(propertyDto);
    return dao.create(classPropertyDto);
  }

  addPropertyToClassProperty(
    classId: number,
    propertyId: number,
  ): Promise<ClassPropertyDto> {
    const dao = new ClassPropertyDao(DaoUtils.getDatabase());
    return dao.addPropertyByClassId(classId, propertyId);
  }

  getClassProperties(classId: number): Promise<ClassPropertyDto> {
    const dao = new ClassPropertyDao(DaoUtils.getDatabase());
    return dao.getByClassId(classId);
  }

  removePropertyFromClassProperty(
    classId: number,
    propertyId: number,
  ): Promise<ClassPropertyDto> {
    const dao = new ClassPropertyDao(DaoUtils.getDatabase());
    return dao.removeProperty(classId, propertyId);
  }

  removeAllClassProperties(classId: number) {
    const dao = new ClassPropertyDao(DaoUtils.getDatabase());
    return dao.deleteByClassId(classId);
  }
}
