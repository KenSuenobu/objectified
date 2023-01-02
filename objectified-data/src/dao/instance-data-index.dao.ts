import {BaseDao} from "./base.dao";
import {InstanceDataDto} from "objectified-services/dist/dto/instance-data.dto";
import * as pgPromise from "pg-promise";

export class InstanceDataIndexDao extends BaseDao<InstanceDataDto> {

    constructor(readonly db: pgPromise.IDatabase<any>) {
        super(db, 'obj.instance_data_index');
    }

}