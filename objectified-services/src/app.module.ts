import {NamespacesService} from './controllers/namespace.service';
import {NamespacesController} from './controllers/namespace.controller';
import {Module} from '@nestjs/common';

@Module({
  imports: [],
  controllers: [
    NamespacesController,
  ],
  providers: [
    NamespacesService,
  ],
})
export class AppModule {}
