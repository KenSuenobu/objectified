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
    const dao = new ClassDao(DaoUtils.getDatabase());
    return dao.edit(id, payload);
  }

  async deleteClass(id: number) {
    const dao = new ClassDao(DaoUtils.getDatabase());
    return dao.deleteById(id);
  }

  async getClass(id: number): Promise<ClassDto> {
    const dao = new ClassDao(DaoUtils.getDatabase());
    return dao.getById(id);
  }

  async getClassByName(name: string): Promise<ClassDto> {
    const dao = new ClassDao(DaoUtils.getDatabase());
    return dao.getByName(name);
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
