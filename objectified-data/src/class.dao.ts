import {NamespaceDto} from 'objectified-services/dist/dto/namespace.dto';
import {BaseDao} from './base.dao';
import {ClassDto} from 'objectified-services/dist/dto/class.dto';
import * as pgPromise from 'pg-promise';

export class ClassDao extends BaseDao<ClassDto> {

  constructor(readonly db: pgPromise.IDatabase<any>) {
    super(db, 'obj.class');
  }

  create(payload: ClassDto): Promise<ClassDto> {
    throw new Error('Unimplemented');
  }

}