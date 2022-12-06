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
import {ObjectPropertiesController} from './controllers/object-property.controller';
import {ObjectPropertiesService} from './controllers/object-property.service';
import {ClassPropertiesService} from './controllers/class-property.service';
import {ClassPropertiesController} from './controllers/class-property.controller';

@Module({
  imports: [],
  controllers: [
    NamespacesController,
    ClassesController,
    DatatypeController,
    FieldsController,
    PropertiesController,
    ObjectPropertiesController,
    ClassPropertiesController,
  ],
  providers: [
    NamespacesService,
    ClassesService,
    DatatypeService,
    FieldsService,
    PropertiesService,
    ObjectPropertiesService,
    ClassPropertiesService,
  ],
})
export class AppModule {}
