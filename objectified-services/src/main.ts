import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

const SERVER_PORT = 3001;

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('main');

  await app.listen(SERVER_PORT).then(() => {
    console.log(
      '       _     _           _   _  __ _          _           _ _     \n' +
        '  ___ | |__ (_) ___  ___| |_(_)/ _(_) ___  __| |       __| | |__  \n' +
        " / _ \\| '_ \\| |/ _ \\/ __| __| | |_| |/ _ \\/ _` |_____ / _` | '_ \\ \n" +
        '| (_) | |_) | |  __/ (__| |_| |  _| |  __/ (_| |_____| (_| | |_) |\n' +
        ' \\___/|_.__// |\\___|\\___|\\__|_|_| |_|\\___|\\__,_|      \\__,_|_.__/ \n' +
        '          |__/                                                    ',
    );
    logger.log(`Listening for connections on http://localhost:${SERVER_PORT}`);
  });
}
bootstrap();
