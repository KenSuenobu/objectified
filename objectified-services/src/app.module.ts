import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { NamespacesController } from './controllers/namespace.controller';
import { NamespacesService } from './services/namespace.service';

@Module({
  imports: [],
  controllers: [AppController, NamespacesController],
  providers: [AppService, NamespacesService],
})
export class AppModule {}
