import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { NamespacesController } from './controllers/namespace.controller';
import { NamespacesService } from './services/namespace.service';
import { ClassesController } from './controllers/class.controller';
import { ClassesService } from './services/class.service';
import { DatatypeController } from './controllers/datatype.controller';
import { DatatypeService } from './services/datatype.service';
import { FieldsController } from './controllers/field.controller';
import { FieldsService } from './services/field.service';
import { PropertyService } from './services/property.service';
import { PropertyController } from './controllers/property.controller';
import {ObjectPropertiesController} from './controllers/object-property.controller';
import {ObjectPropertiesService} from './services/object-property.service';
import {InstancesController} from './controllers/instance.controller';
import {InstancesService} from './services/instance.service';
import {ClassPropertiesController} from './controllers/class-property.controller';
import {ClassPropertiesService} from './services/class-property.service';

@Module({
  imports: [],
  controllers: [
    AppController,
    NamespacesController,
    ClassesController,
    DatatypeController,
    FieldsController,
    PropertyController,
    ObjectPropertiesController,
    ClassPropertiesController,
    InstancesController,
  ],
  providers: [
    AppService,
    NamespacesService,
    ClassesService,
    DatatypeService,
    FieldsService,
    PropertyService,
    ObjectPropertiesService,
    ClassPropertiesService,
    InstancesService,
  ],
})
export class AppModule {}
