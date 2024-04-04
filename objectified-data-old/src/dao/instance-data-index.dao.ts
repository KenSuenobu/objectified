import {BaseDao} from "./base.dao";
import * as pgPromise from "pg-promise";
import {InstanceDataDto} from "../dto/instance-data.dto";

export class InstanceDataIndexDao extends BaseDao<InstanceDataDto> {

    constructor(readonly db: pgPromise.IDatabase<any>) {
        super(db, 'obj.instance_data_index');
    }

}