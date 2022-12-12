import {NamespaceDto} from 'objectified-services/dist/dto/namespace.dto';
import {BaseDao} from './base.dao';

export class NamespaceDao extends BaseDao<NamespaceDto> {

  constructor() {
    super('obj.namespace');
  }

  async create(payload: NamespaceDto): Promise<NamespaceDto> {
    throw new Error('Unimplemented');
  }

  override async deleteById(id: number): Promise<Boolean> {
    const deleteStatement = `UPDATE ${this.getSection()} SET enabled=false WHERE id=$1`;

    return false;
  }

}