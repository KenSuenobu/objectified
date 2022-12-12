import {NamespaceDto} from 'objectified-services/dist/dto/namespace.dto';
import {BaseDao} from './base.dao';
import {ClassDto} from 'objectified-services/dist/dto/class.dto';

export class ClassDao extends BaseDao<ClassDto> {

  constructor() {
    super('obj.class');
  }

  create(payload: ClassDto): Promise<ClassDto> {
    throw new Error('Unimplemented');
  }

}