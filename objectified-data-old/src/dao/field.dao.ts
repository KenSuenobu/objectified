import { BaseDao } from "./base.dao";
import * as pgPromise from "pg-promise";
import { FieldDto } from "../dto/field.dto";

export class FieldDao extends BaseDao<FieldDto> {
  constructor(readonly db: pgPromise.IDatabase<any>) {
    super(db, "obj.field");
  }

  async edit(id: number, payload: FieldDto) {
    const sqlStatement =
      "UPDATE obj.field SET namespace_id=$1, data_type_id=$2, name=$3, description=$4, default_value=$5, enabled=$6, " +
      "update_date=$7 WHERE id=$8";

    return this.db.none(sqlStatement, [
      payload.namespace.id,
      payload.dataType.id,
      payload.name,
      payload.description,
      payload.defaultValue,
      payload.enabled,
      payload.updateDate ?? "NOW()",
      id,
    ]);
  }

  async create(payload: FieldDto): Promise<FieldDto> {
    const sqlStatement =
      "INSERT INTO obj.field (namespace_id, data_type_id, name, description, default_value, enabled, create_date) " +
      "VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *";

    return this.db.oneOrNone(sqlStatement, [
      payload.namespace.id,
      payload.dataType.id,
      payload.name,
      payload.description,
      payload.defaultValue,
      payload.enabled,
      payload.createDate ?? "NOW()",
    ]);
  }
}
