import {InstanceDto} from '../../../objectified-data/src/dto/instance.dto';
import {Injectable, Logger} from '@nestjs/common';
import {InstanceDataDto} from '../../../objectified-data/src/dto/instance-data.dto';
import {PropertyDto} from '../../../objectified-data/src/dto/property.dto';
import {FieldDto} from '../../../objectified-data/src/dto/field.dto';

@Injectable()
export class InstancesService {
  private readonly logger = new Logger('instances.service');

  async createInstance(payload: InstanceDto): Promise<InstanceDto> {
    throw new Error('Unimplemented');
  }

  async createInstanceData(payload: InstanceDataDto) {
    throw new Error('Unimplemented');
  }

  async deleteInstance(id: number) {
    throw new Error('Unimplemented');
  }

  async undeleteInstance(id: number) {
    throw new Error('Unimplemented');
  }

  async getInstanceByName(name: string): Promise<InstanceDto> {
    throw new Error('Unimplemented');
  }

  async getLatestInstanceDataForInstance(id: number): Promise<InstanceDataDto> {
    throw new Error('Unimplemented');
  }

  async getAllInstanceDataForInstance(id: number): Promise<InstanceDataDto[]> {
    throw new Error('Unimplemented');
  }

  async findInstanceByPropertyValue(property: PropertyDto, search: string): Promise<InstanceDataDto[]> {
    throw new Error('Unimplemented');
  }

  async findInstanceByFieldValue(field: FieldDto, search: string): Promise<InstanceDataDto[]> {
    throw new Error('Unimplemented');
  }
}