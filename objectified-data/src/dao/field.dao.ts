import {BaseDao} from './base.dao';
import {FieldDto} from 'objectified-services/dist/dto/field.dto';
import * as pgPromise from 'pg-promise';
import {DataTypeDto} from 'objectified-services/dist/dto/datatype.dto';

export class FieldDao extends BaseDao<FieldDto> {

  constructor(readonly db: pgPromise.IDatabase<any>) {
    super(db, 'obj.field');
  }

  async create(payload: FieldDto): Promise<FieldDto> {
    const sqlStatement = 'INSERT INTO obj.field (data_type_id, name, description, default_value, enabled, create_date) ' +
      'VALUES ($1, $2, $3, $4, $5, $6) RETURNING *';

    return this.db.oneOrNone(sqlStatement, [payload.dataType.id, payload.name, payload.description,
      payload.defaultValue, payload.enabled, payload.createDate ?? 'NOW()']);
  }

}
