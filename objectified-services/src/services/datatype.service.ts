import { Injectable, Logger } from '@nestjs/common';
import { DataTypeDto } from 'objectified-data/dist/src/dto/datatype.dto';
import { DaoUtils } from 'objectified-data/dist/src/dao/dao-utils';
import { DataTypeDao } from 'objectified-data/dist/src/dao/datatype.dao';

@Injectable()
export class DatatypeService {
  private readonly logger = new Logger('datatype.service');

  createDataType(payload: DataTypeDto): Promise<DataTypeDto> {
    const dao = new DataTypeDao(DaoUtils.getDatabase());
    return dao.create(payload);
  }

  getDataTypeById(id: number): Promise<DataTypeDto> {
    const dao = new DataTypeDao(DaoUtils.getDatabase());
    return dao.getById(id);
  }

  getDataTypeByName(name: string): Promise<DataTypeDto> {
    const dao = new DataTypeDao(DaoUtils.getDatabase());
    return dao.getByName(name);
  }

  listDataTypes(): Promise<DataTypeDto[]> {
    const dao = new DataTypeDao(DaoUtils.getDatabase());
    return dao.list();
  }

  async findDataTypes(value: string): Promise<DataTypeDto[]> {
    const dao = new DataTypeDao(DaoUtils.getDatabase());
    return (await dao.list()).filter((x) => {
      return (
        x.name.toLowerCase().indexOf(value.toLowerCase()) !== -1 ||
        x.description.toLowerCase().indexOf(value.toLowerCase()) !== -1
      );
    });
  }

  editDataType(id: number, payload: DataTypeDto): Promise<boolean> {
    const dao = new DataTypeDao(DaoUtils.getDatabase());
    return dao.edit(id, payload);
  }
}
