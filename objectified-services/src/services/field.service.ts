import { Injectable, Logger } from '@nestjs/common';
import { FieldDto } from 'objectified-data/dist/src/dto/field.dto';
import { DaoUtils } from 'objectified-data/dist/src/dao/dao-utils';
import { FieldDao } from 'objectified-data/dist/src/dao/field.dao';

@Injectable()
export class FieldsService {
  private readonly logger = new Logger('fields.service');

  createField(payload: FieldDto): Promise<FieldDto> {
    const dao = new FieldDao(DaoUtils.getDatabase());
    return dao.create(payload);
  }

  getFieldById(id: number): Promise<FieldDto> {
    const dao = new FieldDao(DaoUtils.getDatabase());
    return dao.getById(id);
  }

  getFieldByName(name: string): Promise<FieldDto> {
    const dao = new FieldDao(DaoUtils.getDatabase());
    return dao.getByName(name);
  }

  listFields(): Promise<FieldDto[]> {
    const dao = new FieldDao(DaoUtils.getDatabase());
    return dao.list();
  }

  editField(id: number, payload: FieldDto) {
    const dao = new FieldDao(DaoUtils.getDatabase());
    return dao.edit(id, payload);
  }

  deleteField(id: number) {
    const dao = new FieldDao(DaoUtils.getDatabase());
    return dao.deleteById(id);
  }
}
