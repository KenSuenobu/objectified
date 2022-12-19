import {NamespaceDto} from 'objectified-services/dist/dto/namespace.dto';
import {expect} from 'chai';
import {NamespaceDao} from '../../src/namespace.dao';
import * as pgPromise from 'pg-promise';

describe('#namespaces', async () => {

  const pgp = pgPromise({});
  const db = pgp('postgres://localhost:5432/');

  it('should remove namespaces from tests', async () => {
    await db.none('delete from obj.namespace where name=$1', ['Test']);
  });

  it('should create a namespace DTO object', () => {
    const namespace = new NamespaceDto();
    namespace.name = 'Test';
    namespace.description = 'This is a unit tested namespace';
    expect(namespace.enabled).to.equal(true);
    expect(namespace.id).to.equal(undefined);
  });

  it('should create a namespace object', async () => {
    const namespace = new NamespaceDto();
    namespace.name = 'Test';
    namespace.description = 'This is a unit tested namespace';
    const dao = new NamespaceDao(db);
    const newNamespace: NamespaceDto = await dao.create(namespace)
      .then((result) => result);
    expect(newNamespace.id > 0).to.equal(true);
    expect(newNamespace.name).to.equal(namespace.name);
    expect(newNamespace.createDate).to.not.equal(null);
  });

  it('should get the namespace object that was just created', async () => {
    const dao = new NamespaceDao(db);
    const namespace = await dao.getByName('Test');
    expect(namespace.id > 0).to.equal(true);
    expect(namespace.name).to.equal('Test');
    expect(namespace.description).to.equal('This is a unit tested namespace');
  });

  it('should get by id', async () => {
    const dao = new NamespaceDao(db);
    const namespace = await dao.getByName('Test');
    expect(namespace.id > 0).to.equal(true);
    expect(namespace.name).to.equal('Test');
    expect(namespace.description).to.equal('This is a unit tested namespace');
    const foundNamespace = await dao.getById(namespace.id);
    expect(foundNamespace.id).to.equal(namespace.id);
    expect(foundNamespace.name).to.equal(namespace.name);
    expect(foundNamespace.description).to.equal(namespace.description);
    expect(foundNamespace.createDate).to.equal(namespace.createDate);
  });

  it('should delete the namespace object', async () => {
    const dao = new NamespaceDao(db);
    const namespace = await dao.getByName('Test');
    expect(namespace.id > 0).to.equal(true);
    await dao.deleteById(namespace.id);
  });

  it('should disconnect from the database', async () => {
    pgp.end();
  });

});