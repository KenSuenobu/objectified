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

@Module({
  imports: [],
  controllers: [
    AppController,
    NamespacesController,
    ClassesController,
    DatatypeController,
    FieldsController,
    PropertyController,
  ],
  providers: [
    AppService,
    NamespacesService,
    ClassesService,
    DatatypeService,
    FieldsService,
    PropertyService,
  ],
})
export class AppModule {}
