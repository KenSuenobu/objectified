import { BaseDao } from "./base.dao";
import * as pgPromise from "pg-promise";
import { DataTypeDto } from "../dto/datatype.dto";

export class DataTypeDao extends BaseDao<DataTypeDto> {
  constructor(readonly db: pgPromise.IDatabase<any>) {
    super(db, "obj.data_type");
  }

  async create(payload: DataTypeDto): Promise<DataTypeDto> {
    const sqlStatement =
      "INSERT INTO obj.datatype (name, description, data_type, is_array, max_length, pattern, " +
      "enum_values, enum_description, examples, enabled, create_date) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *";

    return this.db.oneOrNone(sqlStatement, [
      payload.name,
      payload.description,
      payload.dataType,
      payload.isArray,
      payload.maxLength,
      payload.pattern,
      payload.enumValues,
      payload.enumDescriptions,
      payload.examples,
      payload.enabled,
      payload.createDate ?? "NOW()",
    ]);
  }

  async edit(id: number, payload: DataTypeDto) {
    const sqlStatement =
      "UPDATE obj.datatype SET name=$1, description=$2, data_type=$3, is_array=$4, max_length=$5, " +
      "pattern=$6, enum_values=$7, enum_description=$8, examples=$9, enabled=$10, update_date=$11 WHERE id=$12";

    return this.db.none(sqlStatement, [
      payload.name,
      payload.description,
      payload.dataType,
      payload.isArray,
      payload.maxLength,
      payload.pattern,
      payload.enumValues,
      payload.enumDescriptions,
      payload.examples,
      payload.enabled,
      payload.updateDate ?? "NOW()",
      id,
    ]);
  }
}
