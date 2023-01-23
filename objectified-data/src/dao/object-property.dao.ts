import {BaseDao} from "./base.dao";
import * as pgPromise from "pg-promise";
import {PropertyDao} from "./property.dao";
import {ObjectPropertyDto} from "../dto/object-property.dto";

export class ObjectPropertyDao extends BaseDao<ObjectPropertyDto> {

    constructor(readonly db: pgPromise.IDatabase<any>) {
        super(db, 'obj.object_property');
    }

    async create(payload: ObjectPropertyDto) {
        const sqlStatement = 'INSERT INTO obj.object_property (parent_id, child_id) VALUES ($1, $2)';

        for(const property of payload.propertyList) {
            await this.db.oneOrNone(sqlStatement, [payload.parent.id, property.id]);
        }
    }

    override async deleteById(id: number): Promise<Boolean> {
        const deleteStatement = `DELETE FROM ${this.section} WHERE id=$1`;

        return this.db.none(deleteStatement, [id]).then(() => true);
    }

    async deletePropertyFromObject(rootPropertyId: number, childPropertyId: number) {
        const sqlStatement = 'DELETE FROM obj.object_property WHERE parent_id=$1 AND child_id=$2';

        return this.db.none(sqlStatement, [rootPropertyId, childPropertyId]);
    }

    async getByParentId(parentId: number): Promise<ObjectPropertyDto> {
        const propertyDao = new PropertyDao(this.db);
        const sqlStatement = 'SELECT child_id FROM obj.object_property WHERE parent_id=$1';
        const children = await this.db.manyOrNone(sqlStatement, [parentId]);
        const returnObject = new ObjectPropertyDto();

        returnObject.propertyList = [];

        for(const child of children) {
            returnObject.propertyList.push(await propertyDao.getById(child.child_id));
        }

        returnObject.parent = await propertyDao.getById(parentId);

        return returnObject;
    }

}