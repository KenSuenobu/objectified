import { InstanceDto } from 'objectified-data/dist/src/dto/instance.dto';
import { Injectable, Logger } from '@nestjs/common';
import { InstanceDataDto } from 'objectified-data/dist/src/dto/instance-data.dto';
import { PropertyDto } from 'objectified-data/dist/src/dto/property.dto';
import { FieldDto } from 'objectified-data/dist/src/dto/field.dto';
import { DaoUtils } from 'objectified-data/dist/src/dao/dao-utils';
import { InstanceDao } from 'objectified-data/dist/src/dao/instance.dao';
import { InstanceDataDao } from 'objectified-data/dist/src/dao/instance-data.dao';

@Injectable()
export class InstancesService {
  private readonly logger = new Logger('instances.service');

  async createInstance(payload: InstanceDto): Promise<InstanceDto> {
    const dao = new InstanceDao(DaoUtils.getDatabase());
    return dao.create(payload);
  }

  async createInstanceData(payload: InstanceDataDto) {
    throw new Error('Unimplemented');
  }

  async deleteInstance(id: number) {
    const dao = new InstanceDao(DaoUtils.getDatabase());
    return dao.deleteById(id);
  }

  async undeleteInstance(id: number) {
    const dao = new InstanceDao(DaoUtils.getDatabase());
    return dao.undelete(id);
  }

  async getInstanceByName(name: string): Promise<InstanceDto> {
    const dao = new InstanceDao(DaoUtils.getDatabase());
    return dao.getByName(name);
  }

  async getLatestInstanceDataForInstance(id: number): Promise<InstanceDataDto> {
    throw new Error('Unimplemented');
  }

  async getAllInstanceDataForInstance(id: number): Promise<InstanceDataDto[]> {
    throw new Error('Unimplemented');
  }

  async findInstanceByPropertyValue(
    property: PropertyDto,
    search: string,
  ): Promise<InstanceDataDto[]> {
    throw new Error('Unimplemented');
  }

  async findInstanceByFieldValue(
    field: FieldDto,
    search: string,
  ): Promise<InstanceDataDto[]> {
    throw new Error('Unimplemented');
  }
}
