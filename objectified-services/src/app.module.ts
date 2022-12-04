import {NamespacesService} from './controllers/namespace.service';
import {NamespacesController} from './controllers/namespace.controller';
import {Module} from '@nestjs/common';
import {ClassesController} from './controllers/class.controller';
import {ClassesService} from './controllers/class.service';
import {DatatypeController} from './controllers/datatype.controller';
import {DatatypeService} from './controllers/datatype.service';
import {FieldsController} from './controllers/field.controller';
import {FieldsService} from './controllers/field.service';
import {PropertiesController} from './controllers/property.controller';
import {PropertiesService} from './controllers/property.service';

@Module({
  imports: [],
  controllers: [
    NamespacesController,
    ClassesController,
    DatatypeController,
    FieldsController,
    PropertiesController,
  ],
  providers: [
    NamespacesService,
    ClassesService,
    DatatypeService,
    FieldsService,
    PropertiesService,
  ],
})
export class AppModule {}
