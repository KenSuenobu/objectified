import * as pgPromise from 'pg-promise';
import {expect} from 'chai';
import {DataTypeDao} from '../../src/datatype.dao';

describe('#datatype', async () => {

  const pgp = pgPromise({});
  const db = pgp('postgres://localhost:5432/');

  it('should get base data types', async () => {
    const dao = new DataTypeDao(db);
    const dataDto = await dao.getByName('string');
    expect(dataDto.id > 0).to.equal(true);
    expect(dataDto.name).to.equal('string');
    expect(dataDto.description).to.equal('An ISO compliant variable string');
  });

  it('should get by id', async () => {
    const dao = new DataTypeDao(db);
    const dataDto = await dao.getById(2);
    expect(dataDto.id > 0).to.equal(true);
    expect(dataDto.name != null).to.equal(true);
    expect(dataDto.description != null).to.equal(true);
  });

  // it('should disconnect from the database', async () => {
  //   pgp.end();
  // });

});
