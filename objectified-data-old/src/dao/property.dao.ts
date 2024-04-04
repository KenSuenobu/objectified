import { BaseDao } from "./base.dao";
import * as pgPromise from "pg-promise";
import { PropertyDto } from "../dto/property.dto";

export class PropertyDao extends BaseDao<PropertyDto> {
  constructor(readonly db: pgPromise.IDatabase<any>) {
    super(db, "obj.property");
  }

  edit(id: number, payload: PropertyDto) {
    const sqlStatement =
      "UPDATE obj.property SET namespace_id=$1, name=$2, description=$3, field_id=$4, required=$5, nullable=$6, " +
      "is_array=$7, default_value=$8, enabled=$9, indexed=$10, update_date=$11 WHERE id=$12";

    return this.db.none(sqlStatement, [
      payload.namespace.id,
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
      "INSERT INTO obj.property (namespace_id, name, description, field_id, required, nullable, is_array, " +
      "default_value, enabled, indexed, create_date) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *";

    return this.db.oneOrNone(sqlStatement, [
      payload.namespace.id,
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
