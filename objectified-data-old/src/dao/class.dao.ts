import { BaseDao } from "./base.dao";
import * as pgPromise from "pg-promise";
import { ClassDto } from "../dto/class.dto";

export class ClassDao extends BaseDao<ClassDto> {
  constructor(readonly db: pgPromise.IDatabase<any>) {
    super(db, "obj.class");
  }

  async edit(id: number, payload: ClassDto): Promise<Boolean> {
    const sqlStatement =
      "UPDATE obj.class SET name=$1, namespace_id=$2, description=$3, enabled=$4, update_date=$5 WHERE id=$6";

    return this.db
      .none(sqlStatement, [
        payload.name,
        payload.namespace.id,
        payload.description,
        payload.enabled,
        payload.updateDate,
        id,
      ])
      .then(() => true);
  }

  async create(payload: ClassDto): Promise<ClassDto> {
    const sqlStatement =
      "INSERT INTO obj.class (namespace_id, name, description, enabled, create_date) VALUES ($1, $2, $3, $4, $5) RETURNING *";

    return this.db.oneOrNone(sqlStatement, [
      payload.name,
      payload.namespace.id,
      payload.description,
      payload.enabled,
      payload.createDate ?? "NOW()",
    ]);
  }
}
