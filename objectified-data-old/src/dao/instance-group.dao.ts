import { BaseDao } from "./base.dao";
import * as pgPromise from "pg-promise";
import { InstanceDto } from "../dto/instance.dto";
import { InstanceGroupDto } from "src/dto/instance-group.dto";
import {InstanceGroupInstanceDto} from "../dto/instance-group-instance.dto";
import {InstanceDao} from "./instance.dao";

export class InstanceGroupDao extends BaseDao<InstanceGroupDto> {
  constructor(readonly db: pgPromise.IDatabase<any>) {
    super(db, "obj.instance_group");
  }

  async create(payload: InstanceGroupDto): Promise<InstanceGroupDto> {
    const sqlStatement =
      "INSERT INTO obj.instance_group (name, description, enabled, create_date) " +
      "VALUES ($1, $2, $3, $4) RETURNING *";

    return this.db.oneOrNone(sqlStatement, [
      payload.name,
      payload.description,
      payload.enabled,
      payload.createDate ?? "NOW()",
    ]);
  }

  async addInstance(payload: InstanceGroupInstanceDto) {
    const sqlStatement =
      'INSERT INTO obj.instance_group_instance (instance_group_id, instance_id) ' +
      'VALUES ($1, $2) RETURNING *';

    for(const instancePayload of payload.instances) {
      await this.db.oneOrNone(sqlStatement, [
        payload.instanceGroup.id,
        instancePayload.id,
      ]);
    }

    return;
  }

  async getInstancesForGroup(payload: InstanceGroupDto): Promise<InstanceDto[]> {
    const instances: InstanceDto[] = [];
    const sqlStatement: string = 'SELECT instance_id FROM obj.instance_group_instance WHERE instance_group_id=$1';
    const instanceIds = await this.db.manyOrNone(sqlStatement, [payload.id]);
    const instanceDao = new InstanceDao(this.db);

    for(const instanceId of instanceIds) {
      instances.push(await instanceDao.getById(instanceId.instance_id));
    }

    return instances;
  }

  async getInstanceGroupsForInstanceId(payload: InstanceDto): Promise<InstanceGroupDto[]> {
    const instances: InstanceGroupDto[] = [];
    const sqlStatement: string = 'SELECT instance_group_id FROM obj.instance_group WHERE instance_id=$1';
    const instanceGroupIds = await this.db.manyOrNone(sqlStatement, [payload.id]);

    for(const instanceGroupId of instanceGroupIds) {
      instances.push(await this.getById(instanceGroupId.instance_group_id));
    }

    return instances;
  }

}
