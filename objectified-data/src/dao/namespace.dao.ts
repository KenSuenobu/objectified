import {BaseDao} from './base.dao';
import * as pgPromise from 'pg-promise';
import {NamespaceDto} from "../dto/namespace.dto";

export class NamespaceDao extends BaseDao<NamespaceDto> {

  constructor(readonly db: pgPromise.IDatabase<any>) {
    super(db, 'obj.namespace');
  }

  async create(payload: NamespaceDto): Promise<NamespaceDto> {
    const sqlStatement = 'INSERT INTO obj.namespace (name, description, enabled, create_date) VALUES ($1, $2, $3, $4) RETURNING *';

    return this.db.oneOrNone(sqlStatement, [payload.name, payload.description, payload.enabled,
      payload.createDate ?? 'NOW()']);
  }

  async edit(id: number, payload: NamespaceDto): Promise<Boolean> {
    const sqlStatement = 'UPDATE obj.namespace SET name=$1, description=$2, enabled=$3 WHERE id=$4';

    return this.db.none(sqlStatement, [payload.name, payload.description, payload.enabled, id])
      .then(() => true);
  }

  override async deleteById(id: number): Promise<Boolean> {
    const deleteStatement = `UPDATE ${this.section} SET enabled=false WHERE id=$1`;

    return this.db.none(deleteStatement, [id]).then(() => true);
  }

}