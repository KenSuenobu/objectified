import { Injectable, Logger } from '@nestjs/common';
import { PropertyDto } from 'objectified-data/dist/src/dto/property.dto';
import { DaoUtils } from 'objectified-data/dist/src/dao/dao-utils';
import { PropertyDao } from 'objectified-data/dist/src/dao/property.dao';

@Injectable()
export class PropertyService {
  private readonly logger = new Logger('properties.service');

  createProperty(payload: PropertyDto): Promise<PropertyDto> {
    const dao = new PropertyDao(DaoUtils.getDatabase());
    return dao.create(payload);
  }

  getPropertyById(id: number): Promise<PropertyDto> {
    const dao = new PropertyDao(DaoUtils.getDatabase());
    return dao.getById(id);
  }

  getPropertyByName(name: string): Promise<PropertyDto> {
    const dao = new PropertyDao(DaoUtils.getDatabase());
    return dao.getByName(name);
  }

  listProperties(): Promise<PropertyDto[]> {
    const dao = new PropertyDao(DaoUtils.getDatabase());
    return dao.list();
  }

  editProperty(id: number, payload: PropertyDto) {
    const dao = new PropertyDao(DaoUtils.getDatabase());
    return dao.edit(id, payload);
  }

  deleteProperty(id: number) {
    const dao = new PropertyDao(DaoUtils.getDatabase());
    return dao.deleteById(id);
  }
}
