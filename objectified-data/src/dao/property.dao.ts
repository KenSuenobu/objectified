import {PropertyDto} from 'objectified-services/dist/dto/property.dto';
import {BaseDao} from './base.dao';
import * as pgPromise from 'pg-promise';

export class PropertyDao extends BaseDao<PropertyDto> {

  constructor(readonly db: pgPromise.IDatabase<any>) {
    super(db, 'obj.property');
  }

  async create(payload: PropertyDto): Promise<PropertyDto> {
    const sqlStatement = 'INSERT INTO obj.property (name, description, field_id, required, nullable, is_array, ' +
      'default_value, enabled, indexed, create_date) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *';

    return this.db.oneOrNone(sqlStatement, [payload.name, payload.description, payload.field.id, payload.required,
      payload.nullable, payload.isArray, payload.defaultValue, payload.enabled, payload.indexed,
      payload.createDate ?? 'NOW()']);
  }

}