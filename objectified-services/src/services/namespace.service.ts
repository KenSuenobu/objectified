import { Injectable, Logger } from '@nestjs/common';
import { NamespaceDto } from 'objectified-data/dist/src/dto/namespace.dto';
import pgPromise from 'pg-promise';
import { NamespaceDao } from 'objectified-data/dist/src/dao/namespace.dao';
import { DaoUtils } from 'objectified-data/dist/src/dao/dao-utils';

@Injectable()
export class NamespacesService {
  private readonly logger = new Logger('namespace.service');

  async createNamespace(payload: NamespaceDto): Promise<NamespaceDto> {
    const dao = new NamespaceDao(DaoUtils.getDatabase());
    payload.name = payload.name.toLowerCase();
    return dao.create(payload);
  }

  async editNamespace(id: number, payload: NamespaceDto) {
    const dao = new NamespaceDao(DaoUtils.getDatabase());
    payload.name = payload.name.toLowerCase();
    return dao.edit(id, payload);
  }

  async deleteNamespace(id: number): Promise<Boolean> {
    const dao = new NamespaceDao(DaoUtils.getDatabase());

    return dao
      .deleteById(id)
      .then(() => true)
      .catch((e) => {
        throw e;
      });
  }

  async getNamespace(id: number): Promise<NamespaceDto> {
    const dao = new NamespaceDao(DaoUtils.getDatabase());
    return dao.getById(id);
  }

  async getNamespaceByName(name: string): Promise<NamespaceDto> {
    const dao = new NamespaceDao(DaoUtils.getDatabase());
    return dao.getByName(name);
  }

  async listNamespaces(): Promise<NamespaceDto[]> {
    const dao = new NamespaceDao(DaoUtils.getDatabase());
    return dao.list();
  }

  async findNamespaces(value: string): Promise<NamespaceDto[]> {
    const dao = new NamespaceDao(DaoUtils.getDatabase());
    return (await dao.list()).filter((x) => {
      return (
        x.name.toLowerCase().indexOf(value.toLowerCase()) !== -1 ||
        x.description.toLowerCase().indexOf(value.toLowerCase()) !== -1
      );
    });
  }
}
