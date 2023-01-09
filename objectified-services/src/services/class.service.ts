import { Injectable, Logger } from '@nestjs/common';
import { ClassDto } from 'objectified-data/dist/src/dto/class.dto';
import { DaoUtils } from 'objectified-data/dist/src/dao/dao-utils';
import { ClassDao } from 'objectified-data/dist/src/dao/class.dao';

@Injectable()
export class ClassesService {
  private readonly logger = new Logger('class.service');

  async createClass(payload: ClassDto): Promise<ClassDto> {
    const dao = new ClassDao(DaoUtils.getDatabase());
    return dao.create(payload);
  }

  async editClass(id: number, payload: ClassDto) {
    throw new Error('Unimplemented');
  }

  async deleteClass(id: number) {
    throw new Error('Unimplemented');
  }

  async getClass(id: number): Promise<ClassDto> {
    throw new Error('Unimplemented');
  }

  async listClasses(): Promise<ClassDto[]> {
    const dao = new ClassDao(DaoUtils.getDatabase());
    return dao.list();
  }

  async findClasses(value: string): Promise<ClassDto[]> {
    const dao = new ClassDao(DaoUtils.getDatabase());
    return (await dao.list()).filter((x) => {
      return (
        x.name.toLowerCase().indexOf(value.toLowerCase()) !== -1 ||
        x.description.toLowerCase().indexOf(value.toLowerCase()) !== -1
      );
    });
  }
}
