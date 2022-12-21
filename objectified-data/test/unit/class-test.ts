import * as pgPromise from 'pg-promise';
import {expect} from 'chai';
import {ClassDto} from 'objectified-services/dist/dto/class.dto';
import {ClassDao} from '../../src/class.dao';

describe('#class', async () => {

  const pgp = pgPromise({});
  const db = pgp('postgres://localhost:5432/');

  it('should remove class from tests', async () => {
    await db.none('delete from obj.class where name=$1', ['Test']);
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

  it('should get the class object that was just created', async () => {
    const dao = new ClassDao(db);
    const classDto = await dao.getByName('Test');
    expect(classDto.id > 0).to.equal(true);
    expect(classDto.name).to.equal('Test');
    expect(classDto.description).to.equal('This is a unit tested class');
  });

  it('should get by id', async () => {
    const dao = new ClassDao(db);
    const classDto = await dao.getByName('Test');
    expect(classDto.id > 0).to.equal(true);
    expect(classDto.name).to.equal('Test');
    expect(classDto.description).to.equal('This is a unit tested class');
    const foundClass = await dao.getById(classDto.id);
    expect(foundClass.id).to.equal(classDto.id);
    expect(foundClass.name).to.equal(classDto.name);
    expect(foundClass.description).to.equal(classDto.description);
    expect(foundClass.createDate).to.equal(classDto.createDate);
  });

  it('should delete the class object', async () => {
    const dao = new ClassDao(db);
    const classDto = await dao.getByName('Test');
    expect(classDto.id > 0).to.equal(true);
    await dao.deleteById(classDto.id);
  });

  // it('should disconnect from the database', async () => {
  //   pgp.end();
  // });

});
