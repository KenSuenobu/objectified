import { Injectable, Logger } from '@nestjs/common';
import { NamespaceDto } from 'objectified-data/dist/src/dto/namespace.dto';
import pgPromise from 'pg-promise';
import { NamespaceDao } from 'objectified-data/dist/src/dao/namespace.dao';

@Injectable()
export class NamespacesService {
  private readonly logger = new Logger('namespace.service');
  private readonly pgp = pgPromise({});
  private readonly db = this.pgp('postgres://localhost:5432/');

  async createNamespace(payload: NamespaceDto): Promise<NamespaceDto> {
    const dao = new NamespaceDao(this.db);
    return dao.create(payload);
  }

  async editNamespace(id: number, payload: NamespaceDto) {
    const dao = new NamespaceDao(this.db);
    return dao.edit(id, payload);
  }

  async deleteNamespace(id: number): Promise<Boolean> {
    const dao = new NamespaceDao(this.db);

    return dao
      .deleteById(id)
      .then(() => true)
      .catch((e) => {
        throw e;
      });
  }

  async getNamespace(id: number): Promise<NamespaceDto> {
    const dao = new NamespaceDao(this.db);
    return dao.getById(id);
  }

  async getNamespaceByName(name: string): Promise<NamespaceDto> {
    const dao = new NamespaceDao(this.db);
    return dao.getByName(name);
  }

  async listNamespaces(): Promise<NamespaceDto[]> {
    const dao = new NamespaceDao(this.db);
    return dao.list();
  }

  async findNamespaces(value: string): Promise<NamespaceDto[]> {
    const dao = new NamespaceDao(this.db);
    return dao.list().then((r) => {
      return r.filter(
        (x) => x.name.toLowerCase().indexOf(value.toLowerCase()) !== -1,
      );
    });
  }
}
