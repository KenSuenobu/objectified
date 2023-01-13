import { BaseDao } from "./base.dao";
import * as pgPromise from "pg-promise";
import { FieldDto } from "../dto/field.dto";

export class FieldDao extends BaseDao<FieldDto> {
  constructor(readonly db: pgPromise.IDatabase<any>) {
    super(db, "obj.field");
  }

  async edit(id: number, payload: FieldDto) {
    const sqlStatement =
      "UPDATE obj.field SET data_type_id=$1, name=$2, description=$3, default_value=$4, enabled=$5, " +
      "update_date=$6 WHERE id=$7";

    return this.db.none(sqlStatement, [
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
      "INSERT INTO obj.field (data_type_id, name, description, default_value, enabled, create_date) " +
      "VALUES ($1, $2, $3, $4, $5, $6) RETURNING *";

    return this.db.oneOrNone(sqlStatement, [
      payload.dataType.id,
      payload.name,
      payload.description,
      payload.defaultValue,
      payload.enabled,
      payload.createDate ?? "NOW()",
    ]);
  }
}
