import * as pgPromise from 'pg-promise';
import {expect} from 'chai';
import {ClassDto} from 'objectified-services/dist/dto/class.dto';
import {ClassDao} from '../../src/class.dao';
import {InstanceDao} from "../../src/instance.dao";
import {InstanceDto} from "objectified-services/dist/dto/instance.dto";
import { InstanceDataDto } from 'objectified-services/dist/dto/instance-data.dto';
import {InstanceDataDao} from "../../src/instance-data.dao";

describe('#instance-data', async () => {

    const pgp = pgPromise({});
    const db = pgp('postgres://localhost:5432/');

    it('should create a class DTO object', () => {
        const classDto = new ClassDto();
        classDto.name = 'Test';
        classDto.description = 'This is a unit tested class';
        expect(classDto.enabled).to.equal(true);
        expect(classDto.id).to.equal(undefined);
    });

    it('should create a class object', async () => {
        const classDto = new ClassDto();
        classDto.name = 'Test';
        classDto.description = 'This is a unit tested class';
        const dao = new ClassDao(db);
        const newClass: ClassDto = await dao.create(classDto)
            .then((result) => result);
        expect(newClass.id > 0).to.equal(true);
        expect(newClass.name).to.equal(classDto.name);
        expect(newClass.createDate).to.not.equal(null);
    });

    it('should create an instance of an object', async () => {
        const dao = new InstanceDao(db);
        const classDao = new ClassDao(db);
        const instance = new InstanceDto();
        instance.name = 'Test';
        instance.description = 'Test Instance';
        instance.class = await classDao.getByName('Test');
        const createdInstance = await dao.create(instance);
        expect(createdInstance.id > 0).to.equal(true);
        expect(createdInstance.name).to.equal('Test');
        expect(createdInstance.description).to.equal('Test Instance');
    });

    it('should create a data record', async () => {
        const dao = new InstanceDao(db);
        const instanceDataDao = new InstanceDataDao(db);
        const instance = await dao.getByName('Test');
        expect(instance).to.not.equal(null);
        const instanceData = new InstanceDataDto();
        instanceData.instance = instance;
        instanceData.instanceData = {
            'test': 'This is a test message',
        };
        const instanceAfterSave = await instanceDataDao.create(instanceData);
        expect(instanceAfterSave.id).to.not.equal(0);
    });

    it('should cleanup', async () => {
        await db.none('DELETE FROM obj.instance_data');
        await db.none('DELETE FROM obj.instance');
        await db.none('delete from obj.class');
    });

});
