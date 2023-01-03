import {BaseDao} from "./base.dao";
import * as pgPromise from "pg-promise";
import {InstanceDto} from "../dto/instance.dto";

export class InstanceDao extends BaseDao<InstanceDto> {

    constructor(readonly db: pgPromise.IDatabase<any>) {
        super(db, 'obj.instance');
    }

    async create(payload: InstanceDto): Promise<InstanceDto> {
        const sqlStatement = 'INSERT INTO obj.instance (name, description, class_id, enabled, create_date) ' +
            'VALUES ($1, $2, $3, $4, $5) RETURNING *';

        return this.db.oneOrNone(sqlStatement, [payload.name, payload.description, payload.class.id,
            payload.enabled, payload.createDate ?? 'NOW()']);
    }

}