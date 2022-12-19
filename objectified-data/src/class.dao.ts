import {NamespaceDto} from 'objectified-services/dist/dto/namespace.dto';
import {BaseDao} from './base.dao';
import {ClassDto} from 'objectified-services/dist/dto/class.dto';
import * as pgPromise from 'pg-promise';

export class ClassDao extends BaseDao<ClassDto> {

  constructor(readonly db: pgPromise.IDatabase<any>) {
    super(db, 'obj.class');
  }

  async create(payload: ClassDto): Promise<ClassDto> {
    const sqlStatement = 'INSERT INTO obj.class (name, description, enabled, create_date) VALUES ($1, $2, $3, $4) RETURNING *';

    return this.db.oneOrNone(sqlStatement, [payload.name, payload.description, payload.enabled,
      payload.createDate ?? 'NOW()']);
  }

}