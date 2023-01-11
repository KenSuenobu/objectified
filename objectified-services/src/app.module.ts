import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { NamespacesController } from './controllers/namespace.controller';
import { NamespacesService } from './services/namespace.service';
import { ClassesController } from './controllers/class.controller';
import { ClassesService } from './services/class.service';
import { DatatypeController } from './controllers/datatype.controller';
import { DatatypeService } from './services/datatype.service';

@Module({
  imports: [],
  controllers: [
    AppController,
    NamespacesController,
    ClassesController,
    DatatypeController,
  ],
  providers: [AppService, NamespacesService, ClassesService, DatatypeService],
})
export class AppModule {}
