import * as pgPromise from 'pg-promise';
import {expect} from 'chai';
import {FieldDao} from '../../src/field.dao';
import {FieldDto} from 'objectified-services/dist/dto/field.dto';
import {DataTypeDao} from '../../src/datatype.dao';

describe('#field', async () => {

  const pgp = pgPromise({});
  const db = pgp('postgres://localhost:5432/');

  it('should create a field', async () => {
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

  it('should cleanup', async () => {
    await db.none('DELETE FROM obj.field');
  });

  // it('should disconnect from the database', async () => {
  //   pgp.end();
  // });

});
