import {Injectable, Logger} from '@nestjs/common';
import {DataTypeDto} from '../../../objectified-data/src/dto/datatype.dto';

@Injectable()
export class DatatypeService {
  private readonly logger = new Logger('datatype.service');

  createDataType(payload: DataTypeDto): Promise<DataTypeDto> {
    throw new Error("Unimplemented");
  }

  getDataType(id: number): Promise<DataTypeDto> {
    throw new Error("Unimplemented");
  }

  listDataTypes(): Promise<DataTypeDto[]> {
    throw new Error("Unimplemented");
  }

  editDataType(id: number, payload: DataTypeDto): Promise<boolean> {
    throw new Error("Unimplemented");
  }

}