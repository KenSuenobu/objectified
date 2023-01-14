import { BaseDao } from "./base.dao";
import * as pgPromise from "pg-promise";
import { PropertyDto } from "../dto/property.dto";

export class PropertyDao extends BaseDao<PropertyDto> {
  constructor(readonly db: pgPromise.IDatabase<any>) {
    super(db, "obj.property");
  }

  edit(id: number, payload: PropertyDto) {
    const sqlStatement =
      "UPDATE obj.property SET name=$1, description=$2, field_id=$3, required=$4, nullable=$5, " +
      "is_array=$6, default_value=$7, enabled=$8, indexed=$9, update_date=$10 WHERE id=$11";

    return this.db.none(sqlStatement, [
      payload.name,
      payload.description,
      payload.field.id,
      payload.required,
      payload.nullable,
      payload.isArray,
      payload.defaultValue,
      payload.enabled,
      payload.indexed,
      payload.updateDate ?? "NOW()",
      id,
    ]);
  }

  async create(payload: PropertyDto): Promise<PropertyDto> {
    const sqlStatement =
      "INSERT INTO obj.property (name, description, field_id, required, nullable, is_array, " +
      "default_value, enabled, indexed, create_date) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *";

    return this.db.oneOrNone(sqlStatement, [
      payload.name,
      payload.description,
      payload.field.id,
      payload.required,
      payload.nullable,
      payload.isArray,
      payload.defaultValue,
      payload.enabled,
      payload.indexed,
      payload.createDate ?? "NOW()",
    ]);
  }
}
