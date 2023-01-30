import {BaseDao} from "./base.dao";
import * as pgPromise from "pg-promise";
import {InstanceDataDto} from "../dto/instance-data.dto";
import {InstanceDao} from './instance.dao';

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

    async getLatestDataInstance(instanceId: number): Promise<InstanceDataDto> {
        const sqlStatement = 'SELECT * FROM obj.instance_data WHERE instance_id=$1 ORDER BY instance_version DESC LIMIT 1';
        const dao = new InstanceDao(this.db);
        const instanceObject = await dao.getById(instanceId);
        const instanceData = await this.db.oneOrNone<InstanceDataDto>(sqlStatement, [instanceId]);

        instanceData.instance = instanceObject;
        return instanceData;
    }

    async getAllDataByInstanceId(instanceId: number): Promise<InstanceDataDto[]> {
        const sqlStatement = 'SELECT * FROM obj.instance_data WHERE instance_id=$1 ORDER BY instance_version ASC';
        const dao = new InstanceDao(this.db);
        const instanceObject = await dao.getById(instanceId);
        const returnList: InstanceDataDto[] = [];
        const instances = await this.db.manyOrNone<InstanceDataDto[]>(sqlStatement, [instanceId]);

        instances.forEach((x) => {
            x.forEach((y) => {
                y.instance = instanceObject;
                returnList.push(y);
            })
        });

        return returnList;
    }

}