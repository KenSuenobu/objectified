import {NamespaceDto} from 'objectified-services/dist/dto/namespace.dto';
import {BaseDao} from './base.dao';
import * as pgPromise from 'pg-promise';

export class NamespaceDao extends BaseDao<NamespaceDto> {

  constructor(readonly db: pgPromise.IDatabase<any>) {
    super(db, 'obj.namespace');
  }

  async create(payload: NamespaceDto): Promise<NamespaceDto> {
    const sqlStatement = 'INSERT INTO obj.namespace (name, description, enabled, create_date) VALUES (?, ?, ?, ?) RETURNING *';

    return this.db.oneOrNone(sqlStatement, [payload.name, payload.description, payload.enabled,
      payload.createDate ?? 'NOW()']);
  }

  override async deleteById(id: number): Promise<Boolean> {
    const deleteStatement = `UPDATE ${this.section} SET enabled=false WHERE id=$1`;

    return this.db.none(deleteStatement, [id]).then(() => true);
  }

}