import {NamespacesService} from './controllers/namespace.service';
import {NamespacesController} from './controllers/namespace.controller';
import {Module} from '@nestjs/common';
import {ClassesController} from './controllers/class.controller';
import {ClassesService} from './controllers/class.service';

@Module({
  imports: [],
  controllers: [
    NamespacesController,
    ClassesController,
  ],
  providers: [
    NamespacesService,
    ClassesService,
  ],
})
export class AppModule {}
