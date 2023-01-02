import {Injectable, Logger} from "@nestjs/common";
import {FieldDto} from '../../../objectified-data/src/dto/field.dto';

@Injectable()
export class FieldsService {
  private readonly logger = new Logger('fields.service');

  createField(payload: FieldDto): Promise<FieldDto> {
    throw new Error('Unimplemented');
  }

  getFieldById(id: number): Promise<FieldDto> {
    throw new Error('Unimplemented');
  }

  listFields(): Promise<FieldDto[]> {
    throw new Error('Unimplemented');
  }

  editField(id: number, payload: FieldDto) {
    throw new Error('Unimplemented');
  }

  deleteField(id: number) {
    throw new Error('Unimplemented');
  }
}