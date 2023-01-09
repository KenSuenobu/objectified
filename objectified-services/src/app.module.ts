import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { NamespacesController } from './controllers/namespace.controller';
import { NamespacesService } from './services/namespace.service';
import { ClassesController } from './controllers/class.controller';
import { ClassesService } from './services/class.service';

@Module({
  imports: [],
  controllers: [AppController, NamespacesController, ClassesController],
  providers: [AppService, NamespacesService, ClassesService],
})
export class AppModule {}
