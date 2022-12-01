import {NamespacesService} from './controllers/namespace.service';
import {NamespacesController} from './controllers/namespace.controller';
import {Module} from '@nestjs/common';
import {ClassesController} from './controllers/class.controller';
import {ClassesService} from './controllers/class.service';
import {DatatypeController} from './controllers/datatype.controller';
import {DatatypeService} from './controllers/datatype.service';

@Module({
  imports: [],
  controllers: [
    NamespacesController,
    ClassesController,
    DatatypeController,
  ],
  providers: [
    NamespacesService,
    ClassesService,
    DatatypeService,
  ],
})
export class AppModule {}
