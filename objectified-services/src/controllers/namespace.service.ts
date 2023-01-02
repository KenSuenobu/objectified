import {Injectable, Logger} from "@nestjs/common";
import {NamespaceDto} from '../../../objectified-data/src/dto/namespace.dto';

@Injectable()
export class NamespacesService {
  private readonly logger = new Logger('namespace.service');

  async createNamespace(payload: NamespaceDto): Promise<NamespaceDto> {
    throw new Error('Unimplemented');
  }

  async editNamespace(id: number, payload: NamespaceDto) {
    throw new Error('Unimplemented');
  }

  async deleteNamespace(id: number) {
    throw new Error('Unimplemented');
  }

  async getNamespace(id: number): Promise<NamespaceDto> {
    throw new Error('Unimplemented');
  }

  async listNamespaces(): Promise<NamespaceDto[]> {
    throw new Error('Unimplemented');
  }

  async findNamespaces(value: string): Promise<NamespaceDto[]> {
    throw new Error('Unimplemented');
  }
}