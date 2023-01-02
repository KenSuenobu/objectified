import {InstanceDataDto} from "objectified-services/dist/dto/instance-data.dto";
import {BaseDao} from "./base.dao";
import * as pgPromise from "pg-promise";
import {InstanceDto} from "objectified-services/dist/dto/instance.dto";

export class InstanceDataDao extends BaseDao<InstanceDataDto> {

    constructor(readonly db: pgPromise.IDatabase<any>) {
        super(db, 'obj.instance_data');
    }

    async create(payload: InstanceDataDto): Promise<InstanceDataDto> {
        const sqlStatement = 'INSERT INTO obj.instance_data (instance_id, instance_data, instance_version) ' +
            'VALUES ($1, $2, $3) RETURNING *';

        return this.db.oneOrNone(sqlStatement, [payload.instance.id, payload.instanceData,
            payload.instanceVersion]);
    }

}