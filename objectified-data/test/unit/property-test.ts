import * as pgPromise from 'pg-promise';
import {expect} from 'chai';
import {FieldDao} from '../../src/dao/field.dao';
import {FieldDto} from 'objectified-services/dist/dto/field.dto';
import {DataTypeDao} from '../../src/dao/datatype.dao';
import {PropertyDao} from "../../src/dao/property.dao";
import {PropertyDto} from "objectified-services/dist/dto/property.dto";

describe('#property', async () => {

    const pgp = pgPromise({});
    const db = pgp('postgres://localhost:5432/');

    it('should delete test fields', async () => {
        await db.none('DELETE FROM obj.property');
        await db.none('DELETE FROM obj.field');
    })

    it('should create a field for property testing', async () => {
        const dao = new FieldDao(db);
        const dataDao = new DataTypeDao(db);
        const fieldDto = new FieldDto();
        fieldDto.dataType = await dataDao.getByName('string');
        fieldDto.name = 'TestField';
        fieldDto.description = 'Test field created by unit test';
        fieldDto.defaultValue = 'test1234';
        const newFieldDto = await dao.create(fieldDto);
        expect(newFieldDto.id > 0).to.equal(true);
        expect(newFieldDto.name).to.equal(fieldDto.name);
        expect(newFieldDto.description).to.equal(fieldDto.description);
    });

    it('should get by name', async () => {
        const dao = new FieldDao(db);
        const field = await dao.getByName('TestField');
        expect(field.id > 0).to.equal(true);
        expect(field.name).to.equal('TestField');
        expect(field.description).to.equal('Test field created by unit test');
    });

    it('should create a sample property', async () => {
       const dao = new PropertyDao(db);
       const fieldDao = new FieldDao(db);
       const propertyDto = new PropertyDto();
       propertyDto.name = 'test';
       propertyDto.description = 'Test property';
       propertyDto.field = await fieldDao.getByName('TestField');
       propertyDto.required = true;
       propertyDto.nullable = false;
       propertyDto.isArray = false;
       propertyDto.defaultValue = 'test';
       propertyDto.enabled = true;
       propertyDto.indexed = false;
       const savedProperty = await dao.create(propertyDto);
       expect(savedProperty.id > 0).to.equal(true);
    });

    it('should get the property by name', async () => {
        const dao = new PropertyDao(db);
        const propertyDto = await dao.getByName('test');
        expect(propertyDto.id > 0).to.equal(true);
        expect(propertyDto.description).to.equal('Test property');
    });

    it('should delete the sample property', async () => {
        const dao = new PropertyDao(db);
        const property = await dao.getByName('test');
        expect(property.enabled).to.equal(true);
        await dao.deleteById(property.id);
    });

    it('should retrieve the deleted property and double-check its status', async () => {
        const dao = new PropertyDao(db);
        const property = await dao.getByName('test');
        expect(property.enabled).to.equal(false);
    });

    it('should cleanup', async () => {
        await db.none('DELETE FROM obj.property');
        await db.none('DELETE FROM obj.field');
    });

});
