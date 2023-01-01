import {BaseDao} from "./base.dao";
import {ClassPropertyDto} from "objectified-services/dist/dto/class-property.dto";
import * as pgPromise from "pg-promise";
import {PropertyDao} from "./property.dao";
import {ClassDao} from "./class.dao";

export class ClassPropertiesDao extends BaseDao<ClassPropertyDto> {

    constructor(readonly db: pgPromise.IDatabase<any>) {
        super(db, 'obj.class_property');
    }

    async create(payload: ClassPropertyDto) {
        const sqlStatement = 'INSERT INTO obj.class_property (class_id, property_id) VALUES ($1, $2)';

        for(const property of payload.propertyList) {
            await this.db.oneOrNone(sqlStatement, [payload.class.id, property.id]);
        }
    }

    override async deleteById(id: number): Promise<Boolean> {
        const deleteStatement = `DELETE FROM ${this.section} WHERE id=$1`;

        return this.db.none(deleteStatement, [id]).then(() => true);
    }

    async getByClassId(classId: number): Promise<ClassPropertyDto> {
        const classDao = new ClassDao(this.db);
        const propertyDao = new PropertyDao(this.db);
        const sqlStatement = 'SELECT property_id FROM obj.class_property WHERE class_id=$1';
        const children = await this.db.manyOrNone(sqlStatement, [classId]);
        const returnObject = new ClassPropertyDto();

        returnObject.propertyList = [];

        for(const child of children) {
            returnObject.propertyList.push(await propertyDao.getById(child.child_id));
        }

        returnObject.class = await classDao.getById(classId);

        return returnObject;
    }


}