import * as pgPromise from 'pg-promise';
import {expect} from 'chai';
import {ClassDao} from '../../src/dao/class.dao';
import {FieldDao} from "../../src/dao/field.dao";
import {DataTypeDao} from "../../src/dao/datatype.dao";
import {PropertyDao} from "../../src/dao/property.dao";
import {ObjectPropertyDao} from "../../src/dao/object-property.dao";
import {ClassPropertiesDao} from "../../src/dao/class-properties.dao";
import {ClassDto} from "../../src/dto/class.dto";
import {FieldDto} from "../../src/dto/field.dto";
import {PropertyDto} from "../../src/dto/property.dto";
import {ClassPropertyDto} from "../../src/dto/class-property.dto";
import {ObjectPropertyDto} from "../../src/dto/object-property.dto";

describe('#class-properties', async () => {

    const pgp = pgPromise({});
    const db = pgp('postgres://localhost:5432/');

    it('should prepare for tests', async () => {
        await db.none('delete from obj.class_property');
        await db.none('delete from obj.class');
        await db.none('DELETE FROM obj.object_property');
        await db.none('DELETE FROM obj.property');
        await db.none('DELETE FROM obj.field');
    });

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

    it('should create a simple address object', async () => {
        const dao = new FieldDao(db);
        const dataDao = new DataTypeDao(db);
        const streetDto = new FieldDto();
        streetDto.dataType = await dataDao.getByName('string');
        streetDto.name = 'street';
        streetDto.description = 'Street Address';
        await dao.create(streetDto);
        const cityDto = new FieldDto();
        cityDto.dataType = await dataDao.getByName('string');
        cityDto.name = 'city';
        cityDto.description = 'City';
        await dao.create(cityDto);
        const addressDto = new FieldDto();
        addressDto.dataType = await dataDao.getByName('object');
        addressDto.name = 'address';
        addressDto.description = 'Address';
        await dao.create(addressDto);
    });

    it('should create a sample property', async () => {
        const dao = new PropertyDao(db);
        const fieldDao = new FieldDao(db);
        const propertyDto = new PropertyDto();
        propertyDto.name = 'address';
        propertyDto.description = 'Address Object';
        propertyDto.field = await fieldDao.getByName('address');
        propertyDto.required = true;
        propertyDto.nullable = false;
        propertyDto.isArray = false;
        propertyDto.defaultValue = 'test';
        propertyDto.enabled = true;
        propertyDto.indexed = false;
        const savedProperty = await dao.create(propertyDto);
        expect(savedProperty.id > 0).to.equal(true);
        const streetProperty = new PropertyDto();
        streetProperty.name = 'street1';
        streetProperty.description = 'First street address line';
        streetProperty.field = await fieldDao.getByName('street');
        await dao.create(streetProperty);
        const cityProperty = new PropertyDto();
        cityProperty.name = 'city';
        cityProperty.description = 'City of Address';
        cityProperty.field = await fieldDao.getByName('city');
        await dao.create(cityProperty);
    });

    it('should add properties to an object', async () => {
        const dao = new PropertyDao(db);
        const objectPropertyDao = new ObjectPropertyDao(db);
        const objectPropertyDto = new ObjectPropertyDto();

        objectPropertyDto.parent = await dao.getByName('address');
        objectPropertyDto.propertyList = [];
        objectPropertyDto.propertyList.push(await dao.getByName('street1'));
        objectPropertyDto.propertyList.push(await dao.getByName('city'));
        await objectPropertyDao.create(objectPropertyDto);
    });

    it('should create class properties', async () => {
        const dao = new ClassPropertiesDao(db);
        const classDao = new ClassDao(db);
        const propertyDao = new PropertyDao(db);
        const classProperty = new ClassPropertyDto();
        classProperty.class = await classDao.getByName('Test');
        classProperty.propertyList = [];
        classProperty.propertyList.push(await propertyDao.getByName('address'));
        await dao.create(classProperty);
    });

    it('should get class properties', async () => {
        const dao = new ClassPropertiesDao(db);
        const classDao = new ClassDao(db);
        const classObject = await classDao.getByName('Test');
        expect(classObject.id > 0).to.equal(true);
        const results = await dao.getByClassId(classObject.id);
        expect(results.propertyList.length === 1).to.equal(true);
    });

    it('should cleanup', async () => {
        await db.none('delete from obj.class_property');
        await db.none('delete from obj.class');
        await db.none('DELETE FROM obj.object_property');
        await db.none('DELETE FROM obj.property');
        await db.none('DELETE FROM obj.field');
    });

});
